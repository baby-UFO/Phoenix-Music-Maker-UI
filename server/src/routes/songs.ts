import { Router, Response } from 'express';
import { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool.js';
import { authMiddleware, optionalAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getStorageProvider } from '../services/storage/factory.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  convertWithFfmpeg,
  contentTypeFor,
  isExportFormat,
  materializeAudioForExport,
  safeDownloadName,
  LOCAL_AUDIO_DIR,
  type ExportFormat,
} from '../services/ffmpegExport.js';
import {
  masterTrack,
  isFfmpegAvailable,
  measureLoudness,
  MASTER_PRESETS,
  type MasterPresetId,
  type MasterKnobParams,
} from '../services/masterTrack.js';
import { probeMatchering, tryReferenceMatch } from '../services/matcheringSidecar.js';
import multer from 'multer';
import os from 'node:os';

const router = Router();

/** Optional reference WAV/audio for Matchering — never required for core FFmpeg master. */
const masterRefUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const safe = (file.originalname || 'reference').replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `pmm-ref-${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

function maybeMasterRefUpload(req: AuthenticatedRequest, res: Response, next: (err?: unknown) => void) {
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('multipart/form-data')) {
    masterRefUpload.single('reference')(req as any, res as any, next as any);
    return;
  }
  next();
}


// Helper: resolve audio URL (generates signed URL for S3)
async function resolveAudioUrl(audioUrl: string | null): Promise<string | null> {
  if (!audioUrl) return null;

  if (audioUrl.startsWith('s3://')) {
    const storageKey = audioUrl.replace('s3://', '');
    const storage = getStorageProvider();
    return storage.getUrl(storageKey, 3600); // 1 hour expiry
  }

  return audioUrl;
}

// Helper: resolve audio URL for direct playback
async function resolveAccessibleAudioUrl(audioUrl: string | null, isPublic: boolean): Promise<string | null> {
  if (!audioUrl) return null;
  if (audioUrl.startsWith('s3://')) {
    const storageKey = audioUrl.replace('s3://', '');
    const storage = getStorageProvider();
    return isPublic ? storage.getPublicUrl(storageKey) : storage.getUrl(storageKey, 3600);
  }
  return audioUrl;
}

// Get audio - proxies from S3 to avoid CORS issues
router.get('/:id/audio', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT s.audio_url, s.is_public, s.user_id FROM songs s WHERE s.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    const song = result.rows[0];

    if (!song.is_public && (!req.user || req.user.id !== song.user_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const audioUrl = await resolveAudioUrl(song.audio_url);
    if (!audioUrl) {
      res.status(404).json({ error: 'Audio not available' });
      return;
    }

    // Local files - redirect
    if (audioUrl.startsWith('/')) {
      res.redirect(audioUrl);
      return;
    }

    // S3/remote - proxy to avoid CORS
    const range = req.headers.range;
    const audioRes = await fetch(audioUrl, {
      headers: range ? { Range: range } : undefined,
    });
    if (!audioRes.ok && audioRes.status !== 206) {
      res.status(502).json({ error: 'Failed to fetch audio' });
      return;
    }

    const contentType = audioRes.headers.get('content-type') || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    const contentLength = audioRes.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const contentRange = audioRes.headers.get('content-range');
    if (contentRange) {
      res.status(206);
      res.setHeader('Content-Range', contentRange);
    }

    if (audioRes.body) {
      Readable.fromWeb(audioRes.body as any).pipe(res);
      return;
    }

    const arrayBuffer = await audioRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('Get audio error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Download / export via ffmpeg (wav/mp3/flac/ogg/aac)
router.get('/:id/download', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  let tmpPath: string | null = null;
  try {
    const formatRaw = String(req.query.format || 'wav').toLowerCase();
    if (!isExportFormat(formatRaw)) {
      res.status(400).json({ error: 'Invalid format. Use wav, mp3, flac, ogg, or aac.' });
      return;
    }
    const format = formatRaw as ExportFormat;

    const result = await pool.query(
      `SELECT s.audio_url, s.title, s.is_public, s.user_id FROM songs s WHERE s.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    const song = result.rows[0];
    if (!song.is_public && (!req.user || req.user.id !== song.user_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const src = await materializeAudioForExport(song.audio_url || '');
    const srcCleanup = src.cleanup ? src.path : null;
    try {
      const outPath = await convertWithFfmpeg(src.path, format);
      if (outPath !== src.path) tmpPath = outPath;

      const filename = safeDownloadName(song.title, format);
      res.setHeader('Content-Type', contentTypeFor(format));
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      await new Promise<void>((resolve, reject) => {
        res.sendFile(path.resolve(outPath), (err) => {
          if (tmpPath) {
            fs.unlink(tmpPath, () => {});
            tmpPath = null;
          }
          if (srcCleanup) fs.unlink(srcCleanup, () => {});
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (e) {
      if (srcCleanup) fs.unlink(srcCleanup, () => {});
      throw e;
    }
  } catch (error) {
    if (tmpPath) fs.unlink(tmpPath, () => {});
    console.error('Download export error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Export failed' });
  }
});



// Master this track - FFmpeg EQ -> acompressor -> stereotools -> alimiter -> 2-pass loudnorm
// Writes *_master.<ext> next to source (never overwrites source). Phoenix Music Maker.
// Optional Matchering: multipart field "reference" + referenceMatch=true (sidecar only; skip on failure).
router.post('/:id/master', optionalAuthMiddleware, maybeMasterRefUpload, async (req: AuthenticatedRequest, res: Response) => {
  const refFile = (req as any).file as Express.Multer.File | undefined;
  const cleanupPaths: string[] = [];
  if (refFile?.path) cleanupPaths.push(refFile.path);

  try {
    const available = await isFfmpegAvailable();
    if (!available) {
      res.status(503).json({ error: 'FFmpeg is not available on this server. Install ffmpeg and restart.' });
      return;
    }

    const presetRaw = String(req.body?.preset || 'streaming').toLowerCase();
    if (!(presetRaw in MASTER_PRESETS)) {
      res.status(400).json({ error: 'Invalid preset. Use streaming, club, or soft.' });
      return;
    }
    const preset = presetRaw as MasterPresetId;

    const formatRaw = String(req.body?.format || 'wav').toLowerCase();
    if (!isExportFormat(formatRaw)) {
      res.status(400).json({ error: 'Invalid format. Use wav, mp3, flac, ogg, or aac.' });
      return;
    }
    const format = formatRaw as ExportFormat;

    const knobs: MasterKnobParams = {};
    let bodyKnobs = req.body?.knobs || {};
    if (typeof bodyKnobs === 'string') {
      try { bodyKnobs = JSON.parse(bodyKnobs); } catch { bodyKnobs = {}; }
    }
    for (const key of ['bassDb', 'midDb', 'trebleDb', 'compThreshold', 'compRatio', 'stereoWidth', 'limitLevel'] as const) {
      if (bodyKnobs[key] !== undefined && bodyKnobs[key] !== null && bodyKnobs[key] !== '') {
        const n = Number(bodyKnobs[key]);
        if (!Number.isNaN(n)) (knobs as any)[key] = n;
      }
    }

    const result = await pool.query(
      `SELECT s.audio_url, s.title, s.is_public, s.user_id FROM songs s WHERE s.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    const song = result.rows[0];
    if (!song.is_public && (!req.user || req.user.id !== song.user_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    if (!song.audio_url) {
      res.status(400).json({ error: 'Song has no audio' });
      return;
    }

    const wantMatch = String(req.body?.referenceMatch || '').toLowerCase() === 'true' || req.body?.referenceMatch === true;
    let masterInput: string = song.audio_url;
    let matchering: { used: boolean; backend?: string } = { used: false };

    if (wantMatch && refFile?.path) {
      const src = await materializeAudioForExport(song.audio_url);
      if (src.cleanup) cleanupPaths.push(src.path);
      const matched = await tryReferenceMatch({ targetPath: src.path, referencePath: refFile.path });
      if (matched?.outputPath) {
        cleanupPaths.push(matched.outputPath);
        // Park matched WAV under public audio masters/ so *_master gets a /audio URL
        const mastersDir = path.join(LOCAL_AUDIO_DIR, 'masters');
        fs.mkdirSync(mastersDir, { recursive: true });
        const placed = path.join(mastersDir, `match_${Date.now()}.wav`);
        fs.copyFileSync(matched.outputPath, placed);
        cleanupPaths.push(placed);
        masterInput = placed;
        matchering = { used: true, backend: matched.backend };
      }
      // If Matchering unavailable/failed, fall through to FFmpeg-only on original
    }

    const mastered = await masterTrack(masterInput, { preset, format, knobs });

    res.json({
      success: true,
      audioUrl: mastered.publicAudioUrl,
      filename: mastered.filename,
      outputPath: mastered.outputPath,
      format: mastered.format,
      preset: {
        id: mastered.preset.id,
        label: mastered.preset.label,
        I: mastered.preset.I,
        TP: mastered.preset.TP,
        LRA: mastered.preset.LRA,
        description: mastered.preset.description,
      },
      meters: mastered.meters,
      title: song.title,
      matchering,
    });
  } catch (error) {
    console.error('Master track error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Master failed' });
  } finally {
    for (const pth of cleanupPaths) {
      try { fs.unlinkSync(pth); } catch { /* ignore */ }
    }
  }
});

// List master presets (no auth required)

// Loudness QC meters (ffmpeg loudnorm JSON) — no file write
router.get('/:id/loudness', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT s.audio_url, s.is_public, s.user_id FROM songs s WHERE s.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    const song = result.rows[0];
    if (!song.is_public && (!req.user || req.user.id !== song.user_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    if (!song.audio_url) {
      res.status(400).json({ error: 'Song has no audio' });
      return;
    }
    const meters = await measureLoudness(song.audio_url);
    if (!meters) {
      res.status(500).json({ error: 'Loudness measure failed (is ffmpeg available?)' });
      return;
    }
    res.json({ success: true, meters, engine: 'ffmpeg-loudnorm' });
  } catch (error) {
    console.error('Loudness QC error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Loudness failed' });
  }
});

// Matchering sidecar status (optional GPLv3 quarantine — never blocks core master)
router.get('/master/matchering-status', async (_req, res: Response) => {
  try {
    const status = await probeMatchering();
    res.json(status);
  } catch (error) {
    res.json({
      available: false,
      backend: 'unavailable',
      detail: error instanceof Error ? error.message : 'probe failed',
      license: 'GPLv3 (sidecar only — not part of Phoenix Music Maker core)',
    });
  }
});

router.get('/master/presets', (_req, res: Response) => {
  res.json({
    presets: Object.values(MASTER_PRESETS).map((p) => ({
      id: p.id,
      label: p.label,
      I: p.I,
      TP: p.TP,
      LRA: p.LRA,
      description: p.description,
    })),
  });
});

// Get user's songs
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.title, s.lyrics, s.style, s.caption, s.cover_url, s.audio_url,
              s.duration, s.bpm, s.key_scale, s.time_signature, s.tags, s.is_public, 
              s.like_count, s.view_count, s.user_id, s.created_at, s.generation_params,
              COALESCE(u.username, 'Anonymous') as creator
       FROM songs s
       LEFT JOIN users u ON s.user_id = u.id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC`,
      [req.user!.id]
    );

    const songs = await Promise.all(
      result.rows.map(async (row) => ({
        ...row,
        audio_url: await resolveAccessibleAudioUrl(row.audio_url, row.is_public),
      }))
    );

    res.json({ songs });
  } catch (error) {
    console.error('Get songs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get featured songs (random songs for discover page)
router.get('/public/featured', optionalAuthMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    // Return random songs - for local app, show all songs randomly
    const result = await pool.query(
      `SELECT s.id, s.title, s.lyrics, s.style, s.caption, s.cover_url, s.audio_url,
              s.duration, s.bpm, s.key_scale, s.time_signature, s.tags, s.like_count, s.view_count, s.created_at, s.user_id,
              COALESCE(u.username, 'Anonymous') as creator, u.avatar_url as creator_avatar, s.generation_params
       FROM songs s
       LEFT JOIN users u ON s.user_id = u.id
       ORDER BY RANDOM()
       LIMIT 20`
    );

    const songs = await Promise.all(
      result.rows.map(async (row) => ({
        id: row.id,
        title: row.title,
        lyrics: row.lyrics,
        style: row.style,
        caption: row.caption,
        cover_url: row.cover_url,
        audio_url: await resolveAccessibleAudioUrl(row.audio_url, true),
        duration: row.duration,
        bpm: row.bpm,
        key_scale: row.key_scale,
        time_signature: row.time_signature,
        tags: row.tags || [],
        like_count: row.like_count || 0,
        view_count: row.view_count || 0,
        created_at: row.created_at,
        creator: row.creator,
        creator_avatar: row.creator_avatar,
        user_id: row.user_id,
        is_public: true
      }))
    );

    res.json({ songs });
  } catch (error) {
    console.error('Get featured/random songs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get public songs (for explore/home)
router.get('/public', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await pool.query(
      `SELECT s.id, s.title, s.lyrics, s.style, s.caption, s.cover_url, s.audio_url,
              s.duration, s.bpm, s.key_scale, s.time_signature, s.tags, s.like_count, s.created_at,
              COALESCE(u.username, 'Anonymous') as creator, s.generation_params
       FROM songs s
       LEFT JOIN users u ON s.user_id = u.id
       WHERE s.is_public = true
       ORDER BY s.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const songs = await Promise.all(
      result.rows.map(async (row) => ({
        ...row,
        audio_url: await resolveAccessibleAudioUrl(row.audio_url, true),
      }))
    );

    res.json({ songs });
  } catch (error) {
    console.error('Get public songs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single song
router.get('/:id', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.user_id, s.title, s.lyrics, s.style, s.caption, s.cover_url, s.audio_url,
              s.duration, s.bpm, s.key_scale, s.time_signature, s.tags, s.is_public, s.like_count, s.view_count, s.created_at,
              COALESCE(u.username, 'Anonymous') as creator, u.avatar_url as creator_avatar, s.generation_params
       FROM songs s
       LEFT JOIN users u ON s.user_id = u.id
       WHERE s.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    const song = result.rows[0];

    // Check access
    if (!song.is_public && (!req.user || req.user.id !== song.user_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const resolvedSong = {
      ...song,
      audio_url: await resolveAccessibleAudioUrl(song.audio_url, song.is_public),
    };

    res.json({ song: resolvedSong });
  } catch (error) {
    console.error('Get song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get full song details (including comments)
router.get('/:id/full', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [songResult, commentsResult] = await Promise.all([
      pool.query(
        `SELECT s.id, s.user_id, s.title, s.lyrics, s.style, s.caption, s.cover_url, s.audio_url,
                s.duration, s.bpm, s.key_scale, s.time_signature, s.tags, s.is_public,
                s.like_count, s.view_count, s.created_at, s.generation_params,
                COALESCE(u.username, 'Anonymous') as creator, u.avatar_url as creator_avatar
         FROM songs s
         LEFT JOIN users u ON s.user_id = u.id
         WHERE s.id = $1`,
        [req.params.id]
      ),
      pool.query(
        `SELECT c.id, c.content, c.created_at, c.updated_at,
                u.id as user_id, u.username, u.avatar_url
         FROM comments c
         JOIN users u ON c.user_id = u.id
         WHERE c.song_id = $1
         ORDER BY c.created_at DESC`,
        [req.params.id]
      )
    ]);

    if (songResult.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    const song = songResult.rows[0];

    // Check access
    if (!song.is_public && (!req.user || req.user.id !== song.user_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Increment view count
    await pool.query('UPDATE songs SET view_count = view_count + 1 WHERE id = $1', [req.params.id]);

    const resolvedSong = {
      ...song,
      audio_url: await resolveAccessibleAudioUrl(song.audio_url, song.is_public),
    };

    res.json({
      song: resolvedSong,
      comments: commentsResult.rows
    });
  } catch (error) {
    console.error('Get full song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create song (manual, not from generation)
router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      title,
      lyrics,
      style,
      caption,
      coverUrl,
      audioUrl,
      duration,
      bpm,
      keyScale,
      timeSignature,
      tags,
      isPublic,
    } = req.body;

    const result = await pool.query(
      `INSERT INTO songs (user_id, title, lyrics, style, caption, cover_url, audio_url,
                          duration, bpm, key_scale, time_signature, tags, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        req.user!.id,
        title,
        lyrics,
        style,
        caption,
        coverUrl,
        audioUrl,
        duration,
        bpm,
        keyScale,
        timeSignature,
        tags || [],
        isPublic || false,
      ]
    );

    res.status(201).json({ song: result.rows[0] });
  } catch (error) {
    console.error('Create song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update song
router.patch('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Verify ownership
    const check = await pool.query('SELECT user_id FROM songs WHERE id = $1', [req.params.id]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramCount = 1;

    const allowedFields = ['title', 'lyrics', 'style', 'caption', 'cover_url', 'is_public', 'tags'];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${paramCount}`);
        values.push(req.body[field]);
        paramCount++;
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE songs SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json({ song: result.rows[0] });
  } catch (error) {
    console.error('Update song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete song
router.delete('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const check = await pool.query('SELECT user_id, audio_url, cover_url FROM songs WHERE id = $1', [req.params.id]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const song = check.rows[0];
    const storage = getStorageProvider();

    // Delete audio file from storage
    if (song.audio_url) {
      try {
        // Handle local storage paths (/audio/filename.mp3 -> filename.mp3)
        const storageKey = song.audio_url.startsWith('/audio/')
          ? song.audio_url.replace('/audio/', '')
          : song.audio_url.replace('s3://', '');
        await storage.delete(storageKey);
      } catch (err) {
        console.error(`Failed to delete audio file ${song.audio_url}:`, err);
      }
    }

    // Delete cover image if it's stored locally
    if (song.cover_url && song.cover_url.startsWith('/audio/')) {
      try {
        const coverKey = song.cover_url.replace('/audio/', '');
        await storage.delete(coverKey);
      } catch (err) {
        console.error(`Failed to delete cover ${song.cover_url}:`, err);
      }
    }

    await pool.query('DELETE FROM songs WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Like/unlike song
router.post('/:id/like', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if already liked
    const existing = await client.query(
      'SELECT 1 FROM liked_songs WHERE user_id = $1 AND song_id = $2',
      [req.user!.id, req.params.id]
    );

    if (existing.rows.length > 0) {
      // Unlike
      await client.query('DELETE FROM liked_songs WHERE user_id = $1 AND song_id = $2', [
        req.user!.id,
        req.params.id,
      ]);
      // Decrement like_count
      await client.query(
        'UPDATE songs SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1',
        [req.params.id]
      );
      await client.query('COMMIT');
      res.json({ liked: false });
    } else {
      // Like
      await client.query('INSERT INTO liked_songs (user_id, song_id) VALUES ($1, $2)', [
        req.user!.id,
        req.params.id,
      ]);
      // Increment like_count
      await client.query(
        'UPDATE songs SET like_count = like_count + 1 WHERE id = $1',
        [req.params.id]
      );
      await client.query('COMMIT');
      res.json({ liked: true });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Like song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Get liked songs
router.get('/liked/list', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.title, s.lyrics, s.style, s.cover_url, s.audio_url,
              s.duration, s.tags, s.like_count, s.created_at, s.is_public,
              COALESCE(u.username, 'Anonymous') as creator, s.generation_params
       FROM liked_songs ls
       JOIN songs s ON ls.song_id = s.id
       LEFT JOIN users u ON s.user_id = u.id
       WHERE ls.user_id = $1
       ORDER BY ls.liked_at DESC`,
      [req.user!.id]
    );

    const songs = await Promise.all(
      result.rows.map(async (row) => ({
        ...row,
        audio_url: await resolveAccessibleAudioUrl(row.audio_url, row.is_public),
      }))
    );

    res.json({ songs });
  } catch (error) {
    console.error('Get liked songs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle song privacy
router.patch('/:id/privacy', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const check = await pool.query('SELECT user_id, is_public FROM songs WHERE id = $1', [req.params.id]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const newPublicState = !check.rows[0].is_public;

    await pool.query('UPDATE songs SET is_public = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [
      newPublicState,
      req.params.id,
    ]);

    res.json({ isPublic: newPublicState });
  } catch (error) {
    console.error('Toggle privacy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Track song play
router.post('/:id/play', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `UPDATE songs
       SET view_count = COALESCE(view_count, 0) + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING view_count`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    res.json({ viewCount: result.rows[0].view_count });
  } catch (error) {
    console.error('Track play error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get comments for a song
router.get('/:id/comments', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.content, c.created_at, u.username, u.id as user_id, u.avatar_url
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.song_id = $1
       ORDER BY c.created_at DESC`,
      [req.params.id]
    );

    res.json({ comments: result.rows });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add comment to a song
router.post('/:id/comments', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      res.status(400).json({ error: 'Comment content is required' });
      return;
    }

    // Check if song exists and is public
    const songCheck = await pool.query('SELECT is_public FROM songs WHERE id = $1', [req.params.id]);
    if (songCheck.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    if (!songCheck.rows[0].is_public) {
      res.status(403).json({ error: 'Cannot comment on private songs' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO comments (song_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, content, created_at`,
      [req.params.id, req.user!.id, content.trim()]
    );

    const comment = {
      ...result.rows[0],
      username: req.user!.username,
      user_id: req.user!.id,
    };

    res.status(201).json({ comment });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete comment
router.delete('/comments/:commentId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const check = await pool.query('SELECT user_id FROM comments WHERE id = $1', [req.params.commentId]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await pool.query('DELETE FROM comments WHERE id = $1', [req.params.commentId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
