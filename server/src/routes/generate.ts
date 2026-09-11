import { Router, Response } from 'express';
import multer from 'multer';
import { existsSync, statSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db/pool.js';
import { generateUUID } from '../db/sqlite.js';
import { config } from '../config/index.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getGradioClient } from '../services/gradio-client.js';
import {
  generateMusicViaAPI,
  getJobStatus,
  getAudioStream,
  discoverEndpoints,
  checkSpaceHealth,
  cleanupJob, cancelEngineJob,
  getJobRawResponse,
  downloadAudioToBuffer,
  resolvePythonPath,
  ensureEngineBootConfig,
} from '../services/phoenixEngine.js';
import { getStorageProvider } from '../services/storage/factory.js';
import { toEngineModelId, toPhoenixModelId, getPhoenixModelLabel, PHOENIX_DIT_MODELS, PHOENIX_LM_MODELS } from '../utils/phoenixModels.js';

const router = Router();

/** True if a checkpoint dir has usable weights (single safetensors or complete shard set). */
function checkpointHasWeights(modelPath: string, existsSync: typeof import('fs').existsSync, statSync: typeof import('fs').statSync, readFileSync: typeof import('fs').readFileSync): boolean {
  try {
    if (!existsSync(modelPath) || !statSync(modelPath).isDirectory()) return false;
    const single = path.join(modelPath, 'model.safetensors');
    if (existsSync(single) && statSync(single).isFile() && statSync(single).size > 1_000_000) return true;
    const indexPath = path.join(modelPath, 'model.safetensors.index.json');
    if (!existsSync(indexPath)) return false;
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { weight_map?: Record<string, string> };
    const shards = [...new Set(Object.values(index.weight_map || {}))];
    if (shards.length === 0) return false;
    for (const shard of shards) {
      const sp = path.join(modelPath, shard);
      if (!existsSync(sp) || !statSync(sp).isFile() || statSync(sp).size <= 1_000_000) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function listLmModelsFromDisk(checkpointsDir: string) {
  return (PHOENIX_LM_MODELS as readonly string[]).map((name) => {
    const engineName = toEngineModelId(name);
    const candidates = [path.join(checkpointsDir, name), path.join(checkpointsDir, engineName)];
    let is_preloaded = false;
    for (const modelPath of candidates) {
      if (checkpointHasWeights(modelPath, existsSync, statSync, readFileSync)) {
        is_preloaded = true;
        break;
      }
    }
    return {
      name,
      engineName,
      label: getPhoenixModelLabel(name),
      is_preloaded,
    };
  }).sort((a, b) => {
    if (a.is_preloaded !== b.is_preloaded) return a.is_preloaded ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}


// Auto-generate a song title from lyrics or style when none is provided
function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function autoTitle(params: { title?: string; lyrics?: string; instrumental?: boolean; style?: string; songDescription?: string }): string {
  if (params.title?.trim()) return params.title.trim();

  let base = '';

  // Try first meaningful lyric line (skip section markers like [verse], [chorus])
  if (!params.instrumental && params.lyrics) {
    for (const line of params.lyrics.split('\n')) {
      const t = line.trim();
      if (t && !/^\[.*\]$/.test(t)) {
        base = t.length > 32 ? t.slice(0, 32).trimEnd() + 'â€¦' : t;
        break;
      }
    }
  }

  // Fall back to first few style/description words
  if (!base) {
    const source = params.style || params.songDescription || '';
    if (source) {
      const words = source.trim().split(/\s+/).slice(0, 4).join(' ');
      base = words.charAt(0).toUpperCase() + words.slice(1);
    }
  }

  if (!base) base = 'Track';
  // Always stamp so successive gens with the same prompt are distinguishable
  return `${base} Â· ${stamp()}`;
}


async function allocateVersionedSongTitles(userId: string, requestedTitle: string, count: number): Promise<string[]> {
  const raw = (requestedTitle || '').trim();
  if (!raw) {
    return Array.from({ length: count }, (_, i) => `Track Â· ${stamp()}${count > 1 ? `-${i + 1}` : ''}`);
  }

  // Client may already send "Name-3". Trust that stem/number and continue the sequence for batches.
  const peeled = raw.match(/^(.*)-(\d+)$/);
  if (peeled) {
    const stem = peeled[1];
    const startNum = parseInt(peeled[2], 10);
    return Array.from({ length: count }, (_, i) => `${stem}-${startNum + i}`);
  }

  const like = raw.replace(/[%_]/g, '') + '-%';
  const result = await pool.query(
    `SELECT title FROM songs WHERE user_id = ? AND (title = ? OR title LIKE ?)`,
    [userId, raw, like]
  );
  const rows = (result.rows || []) as { title: string }[];
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}-(\\d+)$`);
  let max = 0;
  let sawBare = false;
  for (const row of rows) {
    if (row.title === raw) sawBare = true;
    const m = row.title.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  if (sawBare && max < 1) max = 0;

  return Array.from({ length: count }, (_, i) => `${raw}-${max + 1 + i}`);
}

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'audio/mpeg',
      'audio/mp3', // Alternative MIME type for MP3
      'audio/mpeg3',
      'audio/x-mpeg-3',
      'audio/wav',
      'audio/x-wav',
      'audio/flac',
      'audio/x-flac',
      'audio/mp4',
      'audio/x-m4a',
      'audio/aac',
      'audio/ogg',
      'audio/webm',
      'video/mp4',
    ];

    // Also check file extension as fallback
    const allowedExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.webm', '.opus'];
    const fileExt = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0];

    if (allowedTypes.includes(file.mimetype) || (fileExt && allowedExtensions.includes(fileExt))) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Only common audio formats are allowed. Received: ${file.mimetype} (${file.originalname})`));
    }
  }
});

interface GenerateBody {
  // Mode
  customMode: boolean;

  // Simple Mode
  songDescription?: string;

  // Custom Mode
  lyrics: string;
  style: string;
  title: string;

  // Common
  instrumental: boolean;
  vocalLanguage?: string;

  // Music Parameters
  duration?: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;

  // Generation Settings
  inferenceSteps?: number;
  guidanceScale?: number;
  batchSize?: number;
  randomSeed?: boolean;
  seed?: number;
  thinking?: boolean;
  audioFormat?: 'mp3' | 'flac';
  inferMethod?: 'ode' | 'sde';
  shift?: number;

  // LM Parameters
  lmTemperature?: number;
  lmCfgScale?: number;
  lmTopK?: number;
  lmTopP?: number;
  lmNegativePrompt?: string;
  lmBackend?: 'pt' | 'vllm';
  lmModel?: string;

  // Expert Parameters
  referenceAudioUrl?: string;
  sourceAudioUrl?: string;
  referenceAudioTitle?: string;
  sourceAudioTitle?: string;
  audioCodes?: string;
  repaintingStart?: number;
  repaintingEnd?: number;
  instruction?: string;
  audioCoverStrength?: number;
  coverNoiseStrength?: number;
  taskType?: string;
  useAdg?: boolean;
  cfgIntervalStart?: number;
  cfgIntervalEnd?: number;
  customTimesteps?: string;
  useCotMetas?: boolean;
  useCotCaption?: boolean;
  useCotLanguage?: boolean;
  autogen?: boolean;
  constrainedDecodingDebug?: boolean;
  allowLmBatch?: boolean;
  getScores?: boolean;
  getLrc?: boolean;
  scoreScale?: number;
  lmBatchChunkSize?: number;
  trackName?: string;
  completeTrackClasses?: string[];
  isFormatCaption?: boolean;

  // Model selection
  ditModel?: string;
}

router.post('/upload-audio', authMiddleware, (req: AuthenticatedRequest, res: Response, next: Function) => {
  audioUpload.single('audio')(req, res, (err: any) => {
    if (err) {
      res.status(400).json({ error: err.message || 'Invalid file upload' });
      return;
    }
    next();
  });
}, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Audio file is required' });
      return;
    }

    const storage = getStorageProvider();
    const extFromName = path.extname(req.file.originalname || '').toLowerCase();
    const extFromType = (() => {
      switch (req.file.mimetype) {
        case 'audio/mpeg':
          return '.mp3';
        case 'audio/wav':
        case 'audio/x-wav':
          return '.wav';
        case 'audio/flac':
        case 'audio/x-flac':
          return '.flac';
        case 'audio/ogg':
          return '.ogg';
        case 'audio/mp4':
        case 'audio/x-m4a':
        case 'audio/aac':
          return '.m4a';
        case 'audio/webm':
          return '.webm';
        case 'video/mp4':
          return '.mp4';
        default:
          return '';
      }
    })();
    const ext = extFromName || extFromType || '.audio';
    const key = `references/${req.user!.id}/${Date.now()}-${generateUUID()}${ext}`;
    const storedKey = await storage.upload(key, req.file.buffer, req.file.mimetype);
    const publicUrl = storage.getPublicUrl(storedKey);

    res.json({ url: publicUrl, key: storedKey });
  } catch (error) {
    console.error('Upload reference audio error:', error);
    res.status(500).json({ error: 'Failed to upload audio' });
  }
});

router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  let localJobId: string | null = null;
  try {
    const {
      customMode,
      songDescription,
      lyrics,
      style,
      title,
      instrumental,
      vocalLanguage,
      duration,
      bpm,
      keyScale,
      timeSignature,
      inferenceSteps,
      guidanceScale,
      batchSize,
      randomSeed,
      seed,
      thinking,
      audioFormat,
      inferMethod,
      shift,
      lmTemperature,
      lmCfgScale,
      lmTopK,
      lmTopP,
      lmNegativePrompt,
      lmBackend,
      lmModel,
      referenceAudioUrl,
      sourceAudioUrl,
      referenceAudioTitle,
      sourceAudioTitle,
      audioCodes,
      repaintingStart,
      repaintingEnd,
      instruction,
      audioCoverStrength,
      coverNoiseStrength,
      taskType,
      useAdg,
      cfgIntervalStart,
      cfgIntervalEnd,
      customTimesteps,
      useCotMetas,
      useCotCaption,
      useCotLanguage,
      autogen,
      constrainedDecodingDebug,
      allowLmBatch,
      getScores,
      getLrc,
      scoreScale,
      lmBatchChunkSize,
      trackName,
      completeTrackClasses,
      isFormatCaption,
      ditModel,
    } = req.body as GenerateBody;

    // Normalize client model ids to Phoenix for persistence / UI; engine maps via toEngineModelId
    const ditModelPhoenix = ditModel ? toPhoenixModelId(ditModel) : ditModel;
    const lmModelPhoenix = lmModel ? toPhoenixModelId(lmModel) : lmModel;

    if (!customMode && !songDescription) {
      res.status(400).json({ error: 'Song description required for simple mode' });
      return;
    }

    if (customMode && !style && !lyrics && !referenceAudioUrl) {
      res.status(400).json({ error: 'Style, lyrics, or reference audio required for custom mode' });
      return;
    }

    const params = {
      customMode,
      songDescription,
      lyrics,
      style,
      title,
      instrumental,
      vocalLanguage,
      duration,
      bpm,
      keyScale,
      timeSignature,
      inferenceSteps,
      guidanceScale,
      batchSize,
      randomSeed,
      seed,
      thinking,
      audioFormat,
      inferMethod,
      shift,
      lmTemperature,
      lmCfgScale,
      lmTopK,
      lmTopP,
      lmNegativePrompt,
      lmBackend,
      lmModel: lmModelPhoenix,
      referenceAudioUrl,
      sourceAudioUrl,
      referenceAudioTitle,
      sourceAudioTitle,
      audioCodes,
      repaintingStart,
      repaintingEnd,
      instruction,
      audioCoverStrength,
      coverNoiseStrength,
      taskType,
      useAdg,
      cfgIntervalStart,
      cfgIntervalEnd,
      customTimesteps,
      useCotMetas,
      useCotCaption,
      useCotLanguage,
      autogen,
      constrainedDecodingDebug,
      allowLmBatch,
      getScores,
      getLrc,
      scoreScale,
      lmBatchChunkSize,
      trackName,
      completeTrackClasses,
      isFormatCaption,
      ditModel: ditModelPhoenix,
    };

    // Create job record in database
    localJobId = generateUUID();
    await pool.query(
      `INSERT INTO generation_jobs (id, user_id, status, params, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, datetime('now'), datetime('now'))`,
      [localJobId, req.user!.id, JSON.stringify(params)]
    );

    // Start generation (if this throws, catch marks the DB row failed — avoids eternal queued)
    const { jobId: hfJobId } = await generateMusicViaAPI(params);

    // Store engine task id but keep DB queued until status poll sees engine running
    await pool.query(
      `UPDATE generation_jobs SET phoenix_task_id = ?, status = 'queued', updated_at = datetime('now') WHERE id = ?`,
      [hfJobId, localJobId]
    );

    res.json({
      jobId: localJobId,
      status: 'queued',
      queuePosition: 1,
    });
  } catch (error) {
    console.error('Generate error:', error);
    const message = (error as Error).message || 'Generation failed';
    if (localJobId) {
      try {
        await pool.query(
          `UPDATE generation_jobs SET status = 'failed', error = ?, updated_at = datetime('now')
           WHERE id = ? AND status IN ('pending', 'queued', 'running') AND (phoenix_task_id IS NULL OR phoenix_task_id = '')`,
          [message, localJobId]
        );
      } catch (markErr) {
        console.error('Failed to mark job failed after start error:', markErr);
      }
    }
    res.status(500).json({ error: message });
  }
});

router.get('/status/:jobId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const jobResult = await pool.query(
      `SELECT id, user_id, phoenix_task_id, status, params, result, error, created_at
       FROM generation_jobs
       WHERE id = ?`,
      [req.params.jobId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];

    if (job.user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // If job is still running, check Phoenix Engine status
    if (job.status === 'cancelled') {
      res.json({ id: job.id, status: 'failed', error: 'Cancelled', created_at: job.created_at });
      return;
    }

    // Fail-to-start: queued/running with no engine task id for >15s
    if (['pending', 'queued', 'running'].includes(job.status) && !job.phoenix_task_id) {
      const createdMs = job.created_at ? new Date(job.created_at).getTime() : 0;
      const ageMs = createdMs ? Date.now() - createdMs : 0;
      if (ageMs > 15_000) {
        const failMsg = 'Failed to start Phoenix Engine task';
        await pool.query(
          `UPDATE generation_jobs SET status = 'failed', error = ?, updated_at = datetime('now')
           WHERE id = ? AND status IN ('pending', 'queued', 'running') AND (phoenix_task_id IS NULL OR phoenix_task_id = '')`,
          [failMsg, req.params.jobId]
        );
        res.json({ id: job.id, status: 'failed', error: failMsg, created_at: job.created_at });
        return;
      }
      res.json({
        id: job.id,
        status: job.status,
        queuePosition: 1,
        stage: 'Starting Phoenix Engine...',
        created_at: job.created_at,
      });
      return;
    }

    if (['pending', 'queued', 'running'].includes(job.status) && job.phoenix_task_id) {
      try {
        const aceStatus = await getJobStatus(job.phoenix_task_id);

        // Map-miss from getJobStatus is NOT a real engine failure during early life of a job
        // (in-memory map can lag / restart). Soft-running until ~120s.
        if (
          aceStatus.status === 'failed' &&
          aceStatus.error === 'Job not found' &&
          ['queued', 'running', 'pending'].includes(job.status)
        ) {
          const createdMs = job.created_at ? new Date(job.created_at).getTime() : 0;
          const ageMs = createdMs ? Date.now() - createdMs : 0;
          if (ageMs < 120_000) {
            res.json({
              jobId: req.params.jobId,
              status: job.status === 'pending' ? 'queued' : job.status,
              queuePosition: 1,
              stage: 'Starting...',
              created_at: job.created_at,
            });
            return;
          }
        }

        if (aceStatus.status !== job.status) {
          // Use optimistic lock: only update if status hasn't changed (prevents duplicate song creation)
          let updateQuery = `UPDATE generation_jobs SET status = ?, updated_at = datetime('now')`;
          const updateParams: unknown[] = [aceStatus.status];

          if (aceStatus.status === 'succeeded' && aceStatus.result) {
            updateQuery += `, result = ?`;
            updateParams.push(JSON.stringify(aceStatus.result));
          } else if (aceStatus.status === 'failed' && aceStatus.error) {
            updateQuery += `, error = ?`;
            updateParams.push(aceStatus.error);
          }

          updateQuery += ` WHERE id = ? AND status = ?`;
          updateParams.push(req.params.jobId, job.status);

          const updateResult = await pool.query(updateQuery, updateParams);
          const wasUpdated = updateResult.rowCount > 0;

          // If succeeded AND we were the first to update (optimistic lock), create song records
          if (aceStatus.status === 'succeeded' && aceStatus.result && wasUpdated) {
            const params = typeof job.params === 'string' ? JSON.parse(job.params) : job.params;
            const audioUrls = aceStatus.result.audioUrls.filter((url: string) => {
              const lower = url.toLowerCase();
              return lower.endsWith('.mp3') || lower.endsWith('.flac') || lower.endsWith('.wav');
            });
            const localPaths: string[] = [];
            const storage = getStorageProvider();

            const baseTitle = autoTitle(params);
            const versionedTitles = await allocateVersionedSongTitles(req.user!.id, baseTitle, audioUrls.length);
            for (let i = 0; i < audioUrls.length; i++) {
              const audioUrl = audioUrls[i];
              const songTitle = versionedTitles[i];

              const songId = generateUUID();

              try {
                const { buffer } = await downloadAudioToBuffer(audioUrl);
                const ext = audioUrl.includes('.flac') ? '.flac' : '.mp3';
                const storageKey = `${req.user!.id}/${songId}${ext}`;
                await storage.upload(storageKey, buffer, `audio/${ext.slice(1)}`);
                const storedPath = storage.getPublicUrl(storageKey);

                await pool.query(
                  `INSERT INTO songs (id, user_id, title, lyrics, style, caption, audio_url,
                                      duration, bpm, key_scale, time_signature, tags, is_public, generation_params,
                                      created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))`,
                  [
                    songId,
                    req.user!.id,
                    songTitle,
                    params.instrumental ? '[Instrumental]' : params.lyrics,
                    params.style,
                    params.style,
                    storedPath,
                    aceStatus.result.duration && aceStatus.result.duration > 0 ? aceStatus.result.duration : (params.duration && params.duration > 0 ? params.duration : 0),
                    aceStatus.result.bpm || params.bpm,
                    aceStatus.result.keyScale || params.keyScale,
                    aceStatus.result.timeSignature || params.timeSignature,
                    JSON.stringify([]),
                    JSON.stringify(params),
                  ]
                );

                localPaths.push(storedPath);
              } catch (downloadError) {
                console.error(`Failed to download audio ${i + 1}:`, downloadError);
                // Still create song record with remote URL
                await pool.query(
                  `INSERT INTO songs (id, user_id, title, lyrics, style, caption, audio_url,
                                      duration, bpm, key_scale, time_signature, tags, is_public, generation_params,
                                      created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))`,
                  [
                    songId,
                    req.user!.id,
                    songTitle,
                    params.instrumental ? '[Instrumental]' : params.lyrics,
                    params.style,
                    params.style,
                    audioUrl,
                    aceStatus.result.duration && aceStatus.result.duration > 0 ? aceStatus.result.duration : (params.duration && params.duration > 0 ? params.duration : 0),
                    aceStatus.result.bpm || params.bpm,
                    aceStatus.result.keyScale || params.keyScale,
                    aceStatus.result.timeSignature || params.timeSignature,
                    JSON.stringify([]),
                    JSON.stringify(params),
                  ]
                );
                localPaths.push(audioUrl);
              }
            }

            aceStatus.result.audioUrls = localPaths;
            cleanupJob(job.phoenix_task_id);
          }
        }

        res.json({
          jobId: req.params.jobId,
          status: aceStatus.status,
          queuePosition: aceStatus.queuePosition,
          etaSeconds: aceStatus.etaSeconds,
          progress: aceStatus.progress,
          stage: aceStatus.stage,
          result: aceStatus.result,
          error: aceStatus.error,
        });
        return;
      } catch (aceError) {
        console.error('Phoenix Engine status check error:', aceError);
      }
    }

    // Return stored status
    res.json({
      jobId: req.params.jobId,
      status: job.status,
      progress: undefined,
      stage: undefined,
      result: job.result && typeof job.result === 'string' ? JSON.parse(job.result) : job.result,
      error: job.error,
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Audio proxy endpoint
router.get('/audio', async (req, res: Response) => {
  try {
    const audioPath = req.query.path as string;
    if (!audioPath) {
      res.status(400).json({ error: 'Path required' });
      return;
    }

    const audioResponse = await getAudioStream(audioPath);

    if (!audioResponse.ok) {
      res.status(audioResponse.status).json({ error: 'Failed to fetch audio' });
      return;
    }

    const contentType = audioResponse.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    const contentLength = audioResponse.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const reader = audioResponse.body?.getReader();
    if (!reader) {
      res.status(500).json({ error: 'Failed to read audio stream' });
      return;
    }

    const pump = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        return;
      }
      res.write(value);
      return pump();
    };

    await pump();
  } catch (error) {
    console.error('Audio proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/history', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, phoenix_task_id, status, params, result, error, created_at
       FROM generation_jobs
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user!.id]
    );

    res.json({ jobs: result.rows });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/endpoints', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const endpoints = await discoverEndpoints();
    res.json({ endpoints });
  } catch (error) {
    console.error('Discover endpoints error:', error);
    res.status(500).json({ error: 'Failed to discover endpoints' });
  }
});


// POST /api/generate/ensure-dit — restart Phoenix Engine when Quality chip needs a different boot DiT
router.post('/ensure-dit', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ditModel = String(req.body?.ditModel || req.body?.config_path || '').trim();
    if (!ditModel) {
      res.status(400).json({ error: 'ditModel is required (phoenix-v15-turbo|base|sft)' });
      return;
    }
    const result = await ensureEngineBootConfig(ditModel);
    res.json({
      ok: true,
      restarted: result.restarted,
      configPath: result.configPath,
      note: result.restarted
        ? 'Phoenix Engine restarted with new --config_path. Re-load LoRA after restart.'
        : 'Boot DiT already matched; no restart.',
    });
  } catch (error) {
    console.error('ensure-dit error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to ensure DiT boot config' });
  }
});

router.get('/models', async (_req, res: Response) => {
  try {
    const rawEngineDir = process.env.PHOENIX_ENGINE_PATH || process.env.ACESTEP_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../Phoenix-Engine');
    const PHOENIX_ENGINE_DIR = /ace-step|ACE-Step/i.test(rawEngineDir) ? 'E:\\Phoenix-Engine' : rawEngineDir;
    const checkpointsDir = path.join(PHOENIX_ENGINE_DIR, 'checkpoints');

    // All known DiT models from Gradio's model_downloader.py registry:
    // - MAIN_MODEL_COMPONENTS includes "acestep-v15-turbo" (bundled with main download)
    // - SUBMODEL_REGISTRY includes the rest (separate HuggingFace repos, auto-downloaded on init)
    const ALL_DIT_MODELS = [
      'phoenix-v15-xl-sft',
      'phoenix-v15-xl-base',
      'phoenix-v15-base',
      'phoenix-v15-sft',
      'phoenix-v15-turbo',
      'phoenix-v15-turbo-shift1',
      'phoenix-v15-turbo-shift3',
      'phoenix-v15-turbo-continuous',
    ];
    const ALL_ENGINE_DIT_MODELS = ALL_DIT_MODELS.map((n) => toEngineModelId(n));

    // Query Gradio /v1/models to get the currently loaded/active model
    let activeModel: string | null = null;
    try {
      const apiRes = await fetch(`${config.phoenixEngine.apiUrl}/v1/models`);
      if (apiRes.ok) {
        const data = await apiRes.json() as any;
        const gradioModels = data?.data?.models || data?.models || [];
        if (gradioModels.length > 0) {
          const n = gradioModels[0]?.name || null;
          // This Gradio build often reports name "unknown" — treat as unset so boot status can win.
          activeModel = n && n !== 'unknown' ? n : null;
        }
      }
    } catch {
      // Gradio API unavailable
    }

    // Check which models are downloaded (exist on disk)
    // Matches Gradio's handler.py check_model_exists() and get_available_acestep_v15_models()
    const { existsSync, statSync, readFileSync } = await import('fs');
    const downloaded = new Set<string>();
    for (const phoenixName of ALL_DIT_MODELS) {
      const engineName = toEngineModelId(phoenixName);
      const candidates = [path.join(checkpointsDir, phoenixName), path.join(checkpointsDir, engineName)];
      try {
        for (const modelPath of candidates) {
          if (checkpointHasWeights(modelPath, existsSync, statSync, readFileSync)) {
            downloaded.add(phoenixName);
            break;
          }
        }
      } catch { /* skip */ }
    }

    // Also scan for any additional acestep-v15-* models on disk not in the registry
    // (e.g. user-trained or community models)
    try {
      const { readdirSync } = await import('fs');
      for (const entry of readdirSync(checkpointsDir)) {
        const full = path.join(checkpointsDir, entry);
        if (!statSync(full).isDirectory()) continue;
        if (entry.startsWith('acestep-v15-') || entry.startsWith('phoenix-v15-')) {
          const phoenixName = toPhoenixModelId(entry);
          if (!checkpointHasWeights(full, existsSync, statSync, readFileSync)) continue;
          downloaded.add(phoenixName);
          if (!ALL_DIT_MODELS.includes(phoenixName)) {
            ALL_DIT_MODELS.push(phoenixName);
          }
        }
      }
    } catch { /* checkpoints dir may not exist */ }

    const activePhoenix = activeModel ? toPhoenixModelId(activeModel) : null;
    const models = ALL_DIT_MODELS.map(name => ({
      name, // Phoenix id for client
      engineName: toEngineModelId(name),
      label: getPhoenixModelLabel(name),
      is_active: name === activePhoenix,
      is_preloaded: downloaded.has(name),
    }));

    // Sort: active first, then downloaded, then alphabetical
    models.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      if (a.is_preloaded !== b.is_preloaded) return a.is_preloaded ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Boot checkpoint from env / start-all (runtime /v1/init is 404 on this Gradio build)
    const bootModel =
      process.env.ACESTEP_CONFIG_PATH ||
      process.env.PHOENIX_ENGINE_CONFIG_PATH ||
      null;

    // Best-effort: detect running engine --config_path from a sibling status file if present
    let engineConfigPath: string | null = bootModel;
    try {
      const { readFileSync } = await import('fs');
      const statusPath = path.join(PHOENIX_ENGINE_DIR, 'phoenix-engine-status.json');
      if (existsSync(statusPath)) {
        const st = JSON.parse(readFileSync(statusPath, 'utf8'));
        if (st?.config_path) engineConfigPath = String(st.config_path);
      }
    } catch { /* optional */ }

    // Prefer activeModel from Gradio when available; else boot path
    if (!activeModel && engineConfigPath) {
      activeModel = engineConfigPath;
      const bootPhoenix = toPhoenixModelId(engineConfigPath);
      for (const m of models) {
        m.is_active = m.name === bootPhoenix;
      }
      models.sort((a, b) => {
        if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
        if (a.is_preloaded !== b.is_preloaded) return a.is_preloaded ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }

    const bootPhoenix = engineConfigPath ? toPhoenixModelId(engineConfigPath) : null;
    res.json({
      models,
      bootModel: bootPhoenix,
      engineConfigPath: bootPhoenix,
      engineConfigPathRaw: engineConfigPath,
      note: 'DiT checkpoint is selected at engine boot via --config_path. /v1/init hot-swap is not available on this build. Model IDs in the UI are phoenix-*.',
    });
  } catch (error) {
    console.error('Models error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});


// GET /api/generate/lm-models â€” 5Hz LM checkpoints with disk preload truth
router.get('/lm-models', async (_req, res: Response) => {
  try {
    const rawEngineDir = process.env.PHOENIX_ENGINE_PATH || process.env.ACESTEP_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../Phoenix-Engine');
    const PHOENIX_ENGINE_DIR = /ace-step|ACE-Step/i.test(rawEngineDir) ? 'E:\\Phoenix-Engine' : rawEngineDir;
    const checkpointsDir = path.join(PHOENIX_ENGINE_DIR, 'checkpoints');
    const lmModels = listLmModelsFromDisk(checkpointsDir);
    const preferred = ['phoenix-5Hz-lm-4B', 'phoenix-5Hz-lm-1.7B', 'phoenix-5Hz-lm-0.6B'];
    const best = preferred.find((id) => lmModels.some((m) => m.name === id && m.is_preloaded))
      || lmModels.find((m) => m.is_preloaded)?.name
      || 'phoenix-5Hz-lm-4B';
    res.json({
      lmModels,
      models: lmModels,
      recommended: best,
      note: 'LM ids in the UI are phoenix-*. is_preloaded requires model.safetensors or a complete sharded safetensors set.',
    });
  } catch (error) {
    console.error('LM models error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/generate/random-description â€” Load a random simple description from Gradio
router.get('/random-description', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const client = await getGradioClient();
    const result = await client.predict('/load_random_simple_description', []);
    const data = result.data as unknown[];
    // Returns [description, instrumental, vocal_language]
    res.json({
      description: data[0] || '',
      instrumental: data[1] || false,
      vocalLanguage: data[2] || 'unknown',
    });
  } catch (error) {
    console.error('Random description error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/health', async (_req, res: Response) => {
  try {
    const healthy = await checkSpaceHealth();
    res.json({ healthy, phoenixEngineUrl: config.phoenixEngine.apiUrl });
  } catch (error) {
    res.json({ healthy: false, phoenixEngineUrl: config.phoenixEngine.apiUrl, error: (error as Error).message });
  }
});

router.get('/limits', async (_req, res: Response) => {
  try {
    const { spawn } = await import('child_process');
    const rawEngineDir = process.env.PHOENIX_ENGINE_PATH || process.env.ACESTEP_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../Phoenix-Engine');
    const PHOENIX_ENGINE_DIR = /ace-step|ACE-Step/i.test(rawEngineDir) ? 'E:\\Phoenix-Engine' : rawEngineDir;
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const SCRIPTS_DIR = path.join(__dirname, '../../scripts');
    const LIMITS_SCRIPT = path.join(SCRIPTS_DIR, 'get_limits.py');
    const pythonPath = resolvePythonPath(PHOENIX_ENGINE_DIR);

    const result = await new Promise<{ success: boolean; data?: any; error?: string }>((resolve) => {
      const proc = spawn(pythonPath, [LIMITS_SCRIPT], {
        cwd: PHOENIX_ENGINE_DIR,
        env: {
          ...process.env,
          ACESTEP_PATH: PHOENIX_ENGINE_DIR, PHOENIX_ENGINE_PATH: PHOENIX_ENGINE_DIR,
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0 && stdout) {
          try {
            const parsed = JSON.parse(stdout);
            resolve({ success: true, data: parsed });
          } catch {
            resolve({ success: false, error: 'Failed to parse limits result' });
          }
        } else {
          resolve({ success: false, error: stderr || 'Failed to read limits' });
        }
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });

    if (result.success && result.data) {
      res.json(result.data);
    } else {
      res.status(500).json({ error: result.error || 'Failed to load limits' });
    }
  } catch (error) {
    console.error('Limits error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/debug/:taskId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rawResponse = getJobRawResponse(req.params.taskId);
    if (!rawResponse) {
      res.status(404).json({ error: 'Job not found or no raw response available' });
      return;
    }
    res.json({ rawResponse });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Format endpoint - uses LLM to enhance style/lyrics
router.post('/format', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { caption, lyrics, bpm, duration, keyScale, timeSignature, temperature, topK, topP, lmModel, lmBackend } = req.body;

    if (!caption) {
      res.status(400).json({ error: 'Caption/style is required' });
      return;
    }

    const PHOENIX_ENGINE_API_URL = config.phoenixEngine.apiUrl;

    // Build param_obj for the REST API
    const paramObj: Record<string, unknown> = {};
    if (bpm && bpm > 0) paramObj.bpm = bpm;
    if (duration && duration > 0) paramObj.duration = duration;
    if (keyScale) paramObj.key = keyScale;
    if (timeSignature) paramObj.time_signature = timeSignature;

    // Primary path: call Phoenix Engine /format_input REST endpoint (avoids Python spawn ENOENT on Windows)
    try {
      console.log(`[Format] Calling REST API: ${PHOENIX_ENGINE_API_URL}/format_input`);
      const apiRes = await fetch(`${PHOENIX_ENGINE_API_URL}/format_input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: caption,
          lyrics: lyrics || '',
          temperature: temperature ?? 0.85,
          param_obj: paramObj,
        }),
        signal: AbortSignal.timeout(300_000), // 5 min â€” LLM may need to init first
      });

      const apiData = await apiRes.json() as any;

      if (!apiRes.ok || apiData.code !== 200) {
        const errMsg = apiData.error || apiData.detail || `Format API returned ${apiRes.status}`;
        console.error('[Format] API error:', errMsg);
        res.status(500).json({ success: false, error: errMsg });
        return;
      }

      const d = apiData.data;
      res.json({
        caption: d.caption,
        lyrics: d.lyrics,
        bpm: d.bpm,
        duration: d.duration,
        key_scale: d.key_scale,
        time_signature: d.time_signature,
        vocal_language: d.vocal_language,
      });
      return;
    } catch (fetchErr: any) {
      // Only fall back to Python spawn on network errors (service not yet reachable)
      if (fetchErr?.name !== 'AbortError' && (fetchErr?.code === 'ECONNREFUSED' || fetchErr?.cause?.code === 'ECONNREFUSED')) {
        console.warn('[Format] REST API unreachable, falling back to Python spawn');
      } else {
        console.error('[Format] REST API request failed:', fetchErr?.message);
        res.status(500).json({ success: false, error: fetchErr?.message || 'Format request failed' });
        return;
      }
    }

    // Fallback: Python spawn (only reached when REST API is unreachable)
    const { spawn } = await import('child_process');
    const rawEngineDir = process.env.PHOENIX_ENGINE_PATH || process.env.ACESTEP_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../Phoenix-Engine');
    const PHOENIX_ENGINE_DIR = /ace-step|ACE-Step/i.test(rawEngineDir) ? 'E:\\Phoenix-Engine' : rawEngineDir;
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const SCRIPTS_DIR = path.join(__dirname, '../../scripts');
    const FORMAT_SCRIPT = path.join(SCRIPTS_DIR, 'format_sample.py');
    const pythonPath = resolvePythonPath(PHOENIX_ENGINE_DIR);

    const args = [FORMAT_SCRIPT, '--caption', caption, '--json'];
    if (lyrics) args.push('--lyrics', lyrics);
    if (bpm && bpm > 0) args.push('--bpm', String(bpm));
    if (duration && duration > 0) args.push('--duration', String(duration));
    if (keyScale) args.push('--key-scale', keyScale);
    if (timeSignature) args.push('--time-signature', timeSignature);
    if (temperature !== undefined) args.push('--temperature', String(temperature));
    if (topK && topK > 0) args.push('--top-k', String(topK));
    if (topP !== undefined) args.push('--top-p', String(topP));
    if (lmModel) args.push('--lm-model', toEngineModelId(lmModel));
    if (lmBackend) args.push('--lm-backend', lmBackend);

    console.log(`[Format] Fallback spawn: ${pythonPath} ${args.join(' ')}`);
    const result = await new Promise<{ success: boolean; data?: any; error?: string }>((resolve) => {
      const proc = spawn(pythonPath, args, {
        cwd: PHOENIX_ENGINE_DIR,
        env: { ...process.env, ACESTEP_PATH: PHOENIX_ENGINE_DIR, PHOENIX_ENGINE_PATH: PHOENIX_ENGINE_DIR },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0 && stdout) {
          const lines = stdout.trim().split('\n');
          let jsonStr = '';
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].startsWith('{')) { jsonStr = lines[i]; break; }
          }
          try {
            const parsed = JSON.parse(jsonStr || stdout);
            resolve({ success: true, data: parsed });
          } catch {
            console.error('[Format] Failed to parse stdout:', stdout.slice(0, 500));
            resolve({ success: false, error: 'Failed to parse format result' });
          }
        } else {
          console.error(`[Format] Process exited with code ${code}`);
          if (stdout) console.error('[Format] stdout:', stdout.slice(0, 1000));
          if (stderr) console.error('[Format] stderr:', stderr.slice(0, 1000));
          resolve({ success: false, error: stderr || stdout || `Format process exited with code ${code}` });
        }
      });

      proc.on('error', (err) => {
        console.error('[Format] Spawn error:', err.message);
        resolve({ success: false, error: err.message });
      });
    });

    if (result.success && result.data) {
      res.json(result.data);
    } else {
      console.error('[Format] Python error:', result.error);
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[Format] Route error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});


// POST /api/generate/cancel/:jobId — cancel queued/running generation (no song created)
router.post('/cancel/:jobId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const jobResult = await pool.query(
      `SELECT id, user_id, phoenix_task_id, status FROM generation_jobs WHERE id = ?`,
      [req.params.jobId]
    );
    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const job = jobResult.rows[0];
    if (job.user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    // ALWAYS clear in-memory Gradio/queue state even if DB already terminal (ghost HOL bug)
    if (job.phoenix_task_id) {
      try { cancelEngineJob(job.phoenix_task_id); } catch (e) {
        console.warn('cancelEngineJob on terminal/active job failed:', e);
      }
    }
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      res.json({ id: job.id, status: job.status, cancelled: job.status === 'cancelled' });
      return;
    }
    await pool.query(
      `UPDATE generation_jobs SET status = 'cancelled', error = 'Cancelled', updated_at = datetime('now') WHERE id = ? AND status IN ('pending', 'queued', 'running')`,
      [req.params.jobId]
    );
    res.json({ id: job.id, status: 'cancelled', cancelled: true });
  } catch (error) {
    console.error('Cancel job error:', error);
    res.status(500).json({ error: (error as Error).message || 'Cancel failed' });
  }
});

export default router;
