import { writeFile, mkdir, copyFile, rm, readFile, appendFile } from 'fs/promises';
import { spawn, execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { handle_file } from '@gradio/client';

// Get audio duration using ffprobe
/** Prefer params.duration â€” never block the Node event loop with sync ffprobe (auth-timeout wedge). */
function getAudioDuration(filePath: string): number {
  // Sync ffprobe was blocking /api/auth/auto while /health stayed 200.
  // Duration is usually already on the job params / Gradio result; skip probe on hot path.
  void filePath;
  return 0;
}
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { getGradioClient, resetGradioClient, isGradioAvailable, setInFlightGradioClient, forceCloseGradioSockets } from './gradio-client.js';
import { ensureLoraOffForTurbo } from './loraGuard.js';
import { toEngineModelId, toPhoenixModelId } from '../utils/phoenixModels.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIO_DIR = path.join(__dirname, '../../public/audio');

const ENGINE_API = config.phoenixEngine.apiUrl;

// Resolve Phoenix Engine path (from env or default relative path)
function resolvePhoenixEnginePath(): string {
  const envPath = process.env.PHOENIX_ENGINE_PATH || process.env.ACESTEP_PATH;
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
  }
  // Default: sibling Phoenix Engine install folder (sibling of Phoenix-Music-Maker-UI)
  return path.resolve(__dirname, '../../../Phoenix-Engine');
}

// Resolve Python path cross-platform (supports venv and portable installations)
export function resolvePythonPath(baseDir: string): string {
  // Allow explicit override via env var
  if (process.env.PYTHON_PATH) {
    return process.env.PYTHON_PATH;
  }

  const isWindows = process.platform === 'win32';
  const pythonExe = isWindows ? 'python.exe' : 'python';

  // Check for portable installation first (python_embeded)
  const portablePath = path.join(baseDir, 'python_embeded', pythonExe);
  if (existsSync(portablePath)) {
    return portablePath;
  }

  // Check common venv directory names (Pinokio uses 'env', others use '.venv' or 'venv')
  const venvDirs = ['env', '.venv', 'venv'];
  for (const venvDir of venvDirs) {
    const venvPython = isWindows
      ? path.join(baseDir, venvDir, 'Scripts', pythonExe)
      : path.join(baseDir, venvDir, 'bin', 'python');
    if (existsSync(venvPython)) {
      return venvPython;
    }
  }

  // Fallback to first option (will produce a clear error if not found)
  if (isWindows) {
    return path.join(baseDir, 'env', 'Scripts', pythonExe);
  }
  return path.join(baseDir, 'env', 'bin', 'python');
}

const ENGINE_DIR = resolvePhoenixEnginePath();
const SCRIPTS_DIR = path.join(__dirname, '../../scripts');
const PYTHON_SCRIPT = path.join(SCRIPTS_DIR, 'simple_generate.py');

// ---------------------------------------------------------------------------
// Gradio generation: map params to the 51 positional args for /generation_wrapper
// ---------------------------------------------------------------------------

/**
 * Resolve an audio URL (e.g. /audio/file.mp3) to an absolute local file path.
 */
function resolveAudioPath(audioUrl: string): string {
  if (audioUrl.startsWith('/audio/')) {
    return path.join(AUDIO_DIR, audioUrl.replace('/audio/', ''));
  }
  if (audioUrl.startsWith('http')) {
    try {
      const parsed = new URL(audioUrl);
      if (parsed.pathname.startsWith('/audio/')) {
        return path.join(AUDIO_DIR, parsed.pathname.replace('/audio/', ''));
      }
    } catch { /* fall through */ }
  }
  return audioUrl;
}

/**
 * Prepare a local audio file for Gradio upload.
 * Returns a handle_file() wrapper or null if no file.
 */
async function prepareAudioFile(audioUrl: string | undefined): Promise<unknown> {
  if (!audioUrl) return null;

  const filePath = resolveAudioPath(audioUrl);

  try {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.opus': 'audio/opus', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
    };
    const mimeType = mimeMap[ext] || 'audio/mpeg';
    const blob = new Blob([buffer], { type: mimeType });
    return handle_file(blob);
  } catch (error) {
    console.warn(`[Gradio] Failed to read audio file ${filePath}:`, error);
    // Fall back to URL-based reference if file can't be read locally
    if (audioUrl.startsWith('http')) {
      return handle_file(audioUrl);
    }
    return null;
  }
}

/**
 * Build the 50 positional arguments (Gradio Client API â€” States are auto-injected; do NOT pad null States) for the Gradio /generation_wrapper endpoint.
 */

const GRADIO_TRACK_NAMES = new Set([
  'woodwinds', 'brass', 'fx', 'synth', 'strings', 'percussion',
  'keyboard', 'guitar', 'bass', 'drums', 'backing_vocals', 'vocals',
]);

/** Gradio track_name is an instruments Dropdown â€” never pass song titles. */
function sanitizeGradioTrackName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = String(name).trim();
  return GRADIO_TRACK_NAMES.has(n) ? n : null;
}

function sanitizeGradioTrackClasses(classes: string[] | string | null | undefined): string[] {
  const arr = Array.isArray(classes)
    ? classes
    : typeof classes === 'string'
      ? classes.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  return arr.filter((c) => GRADIO_TRACK_NAMES.has(c));
}
/** Gradio Time Signature dropdown only accepts '', '2', '3', '4', '6', 'N/A' (not '4/4'). */
function normalizeGradioTimeSignature(raw: string | undefined | null): string {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (s === 'N/A' || s === '2' || s === '3' || s === '4' || s === '6') return s;
  // '4/4' | '3/4' | '6/8' -> numerator the dropdown understands
  const m = s.match(/^([2364])\s*\/\s*\d+/);
  if (m) return m[1];
  if (/^[2364]$/.test(s)) return s;
  return '';
}

async function buildGradioArgs(params: GenerationParams): Promise<unknown[]> {
  // Pass the user's BPM through unchanged. No doubling, no "felt tempo" caption hacks.
  const userBpm = params.bpm && params.bpm > 0 ? Math.round(params.bpm) : 0;
  const caption = params.style || 'pop music';

  let prompt = params.customMode ? caption : (params.songDescription || caption);
  const lyrics = params.instrumental ? '' : (params.lyrics || '');

  // Voice descriptions get buried after genre tags and then ignored. Lead with them.
  // Also strip stacked bare "Male vocals" lines from the UI gender toggle.
  // When rap/drill: RAP delivery clauses BEFORE basso/JEJ timbre (celebrity-actor lead biases hummed theater).
  const RAP_RE = /\b(rap|rapping|rapper|drill|trap|hip[- ]?hop|grime|boom[- ]?bap)\b/i;
  const RAP_DELIVERY_RE = /\b(rhythmic rapped|rapped delivery|aggressive spit|tight syllabic|rap vocals|one syllable per beat|no singing|no humming|no melisma|no arabic melismatic|no wordless vocal)\b/i;
  const TIMBRE_RE = /\b(baritone|basso(?:\s+profondo)?|bass voice|bass vocals?|tenor|alto|soprano|contralto|falsetto|profondo|chest voice|male vocals?|female vocals?|male singer|female singer|oratorical|low male|deep male|weathered|james earl jones|speaking f0|speaking fundamental|jej-depth|rapped-pitch)\b/i;
  const promoteVocals = (text: string): string => {
    if (!text) return text;
    const parts = text.split(/,|\n/).map((p) => p.trim()).filter(Boolean);
    const wantsRapLocal = RAP_RE.test(text);
    const vocalRe = wantsRapLocal
      ? new RegExp(RAP_DELIVERY_RE.source + '|' + TIMBRE_RE.source, 'i')
      : /\b(baritone|basso(?:\s+profondo)?|bass voice|bass vocals?|tenor|alto|soprano|contralto|falsetto|profondo|chest voice|male vocals?|female vocals?|male singer|female singer|oratorical|low male|deep male|weathered|rapped delivery|rhythmic rapped)\b/i;
    const vocal = parts.filter((p) => vocalRe.test(p));
    const other = parts.filter((p) => !vocalRe.test(p));
    let rich = vocal.filter((p) => !/^(male|female)\s+vocals?$/i.test(p));
    const hasDeepBass = rich.some((p) => /\b(basso|profondo|bass voice|bass vocals?|james earl jones)\b/i.test(p));
    if (hasDeepBass) {
      rich = rich.filter((p) => !/\bbaritone\b/i.test(p));
    }
    let useVocal = rich.length ? rich : vocal;
    // Rap must lead: delivery / anti-sung before JEJ/basso timbre clauses
    if (wantsRapLocal && useVocal.length > 1) {
      const rapParts = useVocal.filter((p) => RAP_DELIVERY_RE.test(p));
      const timbreParts = useVocal.filter((p) => !RAP_DELIVERY_RE.test(p));
      useVocal = [...timbreParts, ...rapParts]; // JEJ/basso before delivery clauses
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...useVocal, ...other]) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    return out.join(', ');
  };
  prompt = promoteVocals(prompt);

  const wantsRap = RAP_RE.test(prompt);
  if (wantsRap) {
    // Strip speaking/oratorical cues + orphan tenor-Hz fragments that look like positive pitch targets
    prompt = prompt
      .replace(/\bgravelly mature oratorical delivery\b/gi, 'gravelly mature deep male RAPPER timbre')
      .replace(/\boratorical delivery\b/gi, 'rapped delivery')
      .replace(/\boratorical\b/gi, 'rapped')
      .replace(/\bslow deliberate pacing\b/gi, 'tight syllabic flow on-beat')
      .replace(/\bspeaking fundamental frequency\b/gi, 'rapped-pitch fundamental')
      .replace(/\bspeaking F0\b/gi, 'rapped-pitch F0')
      .replace(/\bno\s+tenor\s*\(~?\s*170\s*Hz\+?\s*\)/gi, 'no tenor')
      .replace(/(?<!\d)\(~?\s*170\s*Hz\+?\s*\)/gi, '')
      .replace(/\bJames Earl Jones-like(?:\s+extremely)?\s+deep\s+basso\s+profondo\s+male\s+voice\b/gi,
        'deep basso profondo male RAPPER timbre (JEJ-depth pitch ~85-95 Hz)')
      .replace(/\bJames Earl Jones-like\s+basso\s+profondo\s+male\s+voice\b/gi,
        'deep basso profondo male RAPPER timbre (JEJ-depth pitch ~85-95 Hz)')
      .replace(/,\s*,+/g, ',')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const rapLead = [
      'English UK drill RAP vocals',
      'rhythmic rapped delivery',
      'tight syllabic flow on-beat',
      'aggressive spit',
      'one syllable per beat subdivision',
      'no singing',
      'no humming',
      'no melisma',
      'no Arabic melismatic cries',
      'no wordless vocal runs',
    ];
    // Pull existing parts, drop ones we will re-lead, then rebuild: rap lead -> timbre -> rest
    let parts = prompt.split(/,|\n/).map((p) => p.trim()).filter(Boolean);
    const leadLower = new Set(rapLead.map((c) => c.toLowerCase()));
    parts = parts.filter((p) => !leadLower.has(p.toLowerCase()));
    // Soften remaining celebrity-actor framing that still leads a clause
    parts = parts.map((p) =>
      p.replace(/^James Earl Jones-like\b/gi, 'James Earl Jones-like deep basso profondo male RAPPER voice')
        .replace(/,\s*,+/g, ',')
        .trim()
    ).filter(Boolean);
    const timbreParts = parts.filter((p) => TIMBRE_RE.test(p));
    const otherParts = parts.filter((p) => !TIMBRE_RE.test(p));
    const seen = new Set<string>();
    const ordered: string[] = [];
    // Timbre (JEJ/basso) before long RAP delivery list Ã¢â‚¬â€ depth was getting ignored when buried last
    for (const p of [...timbreParts, ...rapLead, ...otherParts]) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      ordered.push(p);
    }
    prompt = ordered.join(', ');
  }

  // Force deep-basso depth wording when user asked for deep male / baritone / basso
  // For rap: soft JEJ-depth pitch cue AFTER rap lead Ã¢â‚¬â€ never celebrity-actor / speaking-F0 lead.
  const wantsJeJDepth = /\b(baritone|basso|profondo|james earl jones|jej-depth|chest voice|low male|deep male|oratorical)\b/i.test(prompt);
  if (wantsJeJDepth && !/jej-depth|james earl jones/i.test(prompt)) {
    const jejLead = wantsRap
      ? 'deep basso profondo male RAPPER timbre (JEJ-depth pitch ~85-95 Hz), rapped-pitch F0 ~85-95 Hz (E2-F#2), stay in chest register ~80-105 Hz (C2-G2), dark resonant chest, gravelly mature deep male RAPPER timbre, rumbling low register, no tenor'
      : 'James Earl Jones-like extremely deep basso profondo male voice, speaking fundamental frequency ~90 Hz (about F#2), stay in ~85-100 Hz chest register, C2-G2, dark resonant chest voice, gravelly mature deep male timbre, rumbling low register, no tenor';
    prompt = wantsRap ? `${prompt}, ${jejLead}` : `${jejLead}, ${prompt}`;
  } else if (wantsRap && wantsJeJDepth) {
    // Already has JEJ/depth wording Ã¢â‚¬â€ ensure rap lead is still first (promote may have run before rewrite)
    prompt = promoteVocals(prompt);
  }


  // Lock dialed tempo in the caption (exact BPM, never doubled). Keeps vocal lead, then tempo.
  if (userBpm > 0) {
    const tempoLock = wantsRap
      ? `${userBpm} BPM, 4/4, kick on every beat, snare on 2 and 4, full-time from bar 1, not half-time intro, not half-time, not ${Math.round(userBpm / 2)} BPM`
      : `${userBpm} BPM, 4/4, kick on every beat, snare on 2 and 4, not half-time, not ${Math.round(userBpm / 2)} BPM`;
    if (!new RegExp(`^${userBpm}\\s*BPM\\b`, 'i').test(prompt)) {
      prompt = `${prompt}, ${tempoLock}`; // keep LoRA trigger at front
    }
  }

  // Think + CoT metas lets constrained decoding lock the BPM field the engine already supports

  // LoRA / style trigger must lead the caption (tempo/rap rewrites used to bury it).
  {
    const triggerRe = /^\s*(babyUFO style|babyUFO)\s*,\s*/i;
    let trigger = '';
    const m = prompt.match(triggerRe);
    if (m) {
      trigger = 'babyUFO style, ';
      prompt = prompt.slice(m[0].length);
    } else {
      const parts = prompt.split(/,/).map((p) => p.trim()).filter(Boolean);
      const kept: string[] = [];
      for (const p of parts) {
        if (/^babyUFO style$/i.test(p) || /^babyUFO$/i.test(p)) {
          trigger = 'babyUFO style, ';
          continue;
        }
        kept.push(p);
      }
      prompt = kept.join(', ');
    }
    if (!trigger) trigger = 'babyUFO style, ';
    prompt = `${trigger}${prompt}`.replace(/,\s*,+/g, ', ').replace(/^,\s*/, '').trim();
  }

  // Hard pitch-lock for JEJ/basso asks Ã¢â‚¬â€ model otherwise parks ~130 Hz light baritone.
  if (/\b(james earl jones|jej-depth|basso|profondo|85-95\s*Hz|~90\s*Hz)\b/i.test(prompt)) {
    const pitchLock = 'James Earl Jones basso profondo, vocal fundamental ~90 Hz (F#2), stay below 100 Hz chest, one octave deeper than typical male rap, rumbling 85 Hz drone voice';
    if (!/vocal fundamental ~90 Hz/i.test(prompt)) {
      prompt = prompt.replace(/^(babyUFO style,\s*)/i, `$1${pitchLock}, `);
    }
  }
  const isThinking = params.thinking ?? false; // do not force Think on BPM (was causing screech/noise)
  const isEnhance = params.enhance ?? false;

  const taskType = (params.taskType === 'audio2audio' ? 'cover' : params.taskType) || 'text2music';
  const needsSource = taskType === 'cover' || taskType === 'repaint';

  const referenceAudio = await prepareAudioFile(params.referenceAudioUrl);
  const sourceAudio = needsSource
    ? await prepareAudioFile(params.sourceAudioUrl)
    : null;

  if (needsSource && params.sourceAudioUrl && sourceAudio === null) {
    throw new Error(`Source audio file could not be loaded from: ${params.sourceAudioUrl}. Make sure the file was uploaded successfully.`);
  }

  const wantCotMetas = (isEnhance || isThinking) ? (params.useCotMetas ?? true) : (params.useCotMetas ?? false);
  // Don't rewrite the user's caption when BPM is set Ã¢â‚¬â€ that was scrambling tempo cues
  const wantCotCaption = userBpm > 0 ? false : (isEnhance || isThinking) ? (params.useCotCaption ?? true) : false;
  const wantCotLanguage = (isEnhance || isThinking) ? (params.useCotLanguage ?? true) : false;

  let lmNegative = params.lmNegativePrompt || 'NO USER INPUT';
  const wantsDeepMale = /\b(baritone|basso|profondo|chest voice|low male|deep male|deep basso)\b/i.test(prompt);
  if (wantsDeepMale) {
    const antiHigh = 'Justin Bieber-like light pop male vocals, youthful teen tenor (~170-185 Hz), thin nasal voice, breathy pop crooner, falsetto, high pitched male vocals, chipmunk vocals, female vocals, soprano, child vocals, fake baritone, light pop baritone ~130-150 Hz, tenor drift above ~110 Hz, forced low voice without chest resonance';
    if (!lmNegative || lmNegative === 'NO USER INPUT') lmNegative = antiHigh;
    else if (!/falsetto|tenor|high pitched/i.test(lmNegative)) lmNegative = `${lmNegative}, ${antiHigh}`;
  }
  if (userBpm > 0) {
    const antiHalf = `half-time feel, slow ${Math.round(userBpm / 2)} BPM groove, lethargic ballad pacing, dragging tempo`;
    if (!lmNegative || lmNegative === 'NO USER INPUT') lmNegative = antiHalf;
    else if (!/half-time feel|dragging tempo/i.test(lmNegative)) lmNegative = `${lmNegative}, ${antiHalf}`;
  }
  if (wantsRap) {
    const antiSung = 'humming, melismatic singing, slow sung ballad vocals, crooning, operatic vocals, legato sung melody, spoken-sung hybrid, Arabic melismatic cries, mawwal, wordless humming, vocal wails, melismatic ad-libs, sung vowel runs, chanting, Gregorian, operatic aria';
    if (!lmNegative || lmNegative === 'NO USER INPUT') lmNegative = antiSung;
    else if (!/Arabic melismatic|mawwal|wordless humming|vocal wails|melismatic ad-libs|sung vowel runs|chanting|Gregorian|operatic aria/i.test(lmNegative)) {
      lmNegative = `${lmNegative}, ${antiSung}`;
    }
  }


  try {
    const fs = await import('fs');
    void appendFile('E:/Phoenix-Music-Maker-UI/server/bpm-debug.log', JSON.stringify({
        t: new Date().toISOString(),
        userBpm,
        engineBpm: userBpm,
        isThinking,
        wantCotMetas,
        wantCotCaption,
        promptStart: String(prompt).slice(0, 260),
        tempoLocked: userBpm > 0,
        wantsDeepMale: /\b(baritone|basso|profondo|chest voice|low male|deep male)\b/i.test(String(prompt)),
        lmNegativeStart: String(lmNegative).slice(0, 120),
      }) + '\n',
    ).catch(() => {});
  } catch {
    // ignore
  }

  console.log('[buildGradioArgs] bpm=', userBpm, 'thinking=', isThinking);

  return [
    prompt,                                                       //  0: Music Caption
    lyrics,                                                       //  1: Lyrics
    userBpm,                                                      //  2: BPM (exact user value)
    params.keyScale || '',                                        //  3: Key
    (userBpm > 0 ? (normalizeGradioTimeSignature(params.timeSignature) || '4') : normalizeGradioTimeSignature(params.timeSignature)), //  4: Time Signature (Gradio literals, not '4/4')
    params.vocalLanguage || 'en',                                 //  5: Vocal Language
    params.inferenceSteps ?? 8,                                   //  6: DiT Inference Steps
    params.guidanceScale ?? 7.0,                                  //  7: DiT Guidance Scale
    params.randomSeed !== false,                                  //  8: Random Seed
    String(params.seed ?? -1),                                    //  9: Seed
    referenceAudio,                                               // 10: Reference Audio
    params.duration && params.duration > 0 ? params.duration : -1, // 11: Audio Duration
    Math.min(Math.max(params.batchSize ?? 1, 1), 16),            // 12: Batch Size
    sourceAudio,                                                  // 13: Source Audio
    params.audioCodes || '',                                      // 14: LM Codes Hints
    params.repaintingStart ?? 0.0,                                // 15: Repainting Start
    params.repaintingEnd ?? -1,                                   // 16: Repainting End
    params.instruction || 'Fill the audio semantic mask with the style described in the text prompt.', // 17: Instruction
    params.audioCoverStrength ?? 1.0,                             // 18: audio_cover_strength (Gradio UI order)
    (params.coverNoiseStrength ?? 0.0),                           // 19: cover_noise_strength â€” MUST be 0 for text2music or DiT collapses to 1 step
    taskType,                                                     // 20: task_type
    params.useAdg ?? false,                                       // 21: Use ADG
    params.cfgIntervalStart ?? 0.0,                               // 22: CFG Interval Start
    params.cfgIntervalEnd ?? 1.0,                                 // 23: CFG Interval End
    (params.shift != null
      ? params.shift
      : (params.ditModel && /turbo/i.test(params.ditModel) ? 3.0 : 1.0)), // 24: Shift â€” non-turbo known-good is 1.0 (SFT+LoRA); turbo keeps 3.0
    params.inferMethod || 'ode',                                  // 25: Inference Method
    params.customTimesteps || '',                                 // 26: Custom Timesteps
    params.audioFormat || 'mp3',                                  // 27: Audio Format
    params.lmTemperature ?? 0.85,                                 // 28: LM Temperature
    isThinking,                                                   // 29: Think
    params.lmCfgScale ?? 2.0,                                     // 30: LM CFG Scale
    params.lmTopK ?? 0,                                           // 31: LM Top-K
    params.lmTopP ?? 0.9,                                         // 32: LM Top-P
    lmNegative,                                                   // 33: LM Negative Prompt
    wantCotMetas,                                                 // 34: CoT Metas
    wantCotCaption,                                               // 35: CaptionRewrite
    wantCotLanguage,                                              // 36: CoT Language
    // is_format_caption_state is UI-only Gradio State â€” Client API omits it (auto-injected).
    params.constrainedDecodingDebug ?? false,                     // 37: Constrained Decoding Debug
    params.allowLmBatch ?? true,                                  // 38: ParallelThinking
    params.getScores ?? false,                                    // 39: Auto Score
    params.getLrc ?? false,                                       // 40: Auto LRC
    params.scoreScale ?? 0.5,                                     // 41: Quality Score Sensitivity
    params.lmBatchChunkSize ?? 8,                                 // 42: LM Batch Chunk Size
    sanitizeGradioTrackName(params.trackName),                    // 43: Track Name (instruments Dropdown only)
    sanitizeGradioTrackClasses(params.completeTrackClasses),      // 44: Complete Track Classes
    true,                                                         // 45: Enable Normalization
    -1.0,                                                         // 46: Target Peak (dB)
    0.0,                                                          // 47: Latent Shift
    1.0,                                                          // 48: Latent Rescale
    params.autogen ?? false,                                      // 49: AutoGen (API last field; batch States auto-injected)
  ];
}

/**
 * Download a Gradio audio result file to local storage.
 * Gradio returns file objects with { url, path, orig_name, ... }.
 * We copy from the server-local path (same machine) or download via URL.
 */
async function downloadGradioAudioFile(
  fileObj: { url?: string; path?: string; orig_name?: string },
  destPath: string,
): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });

  // Prefer direct filesystem copy (both servers on same machine)
  if (fileObj.path && existsSync(fileObj.path)) {
    await copyFile(fileObj.path, destPath);
    return;
  }

  // Fall back to HTTP download via Gradio URL (use temp file for atomicity)
  if (fileObj.url) {
    const response = await fetch(fileObj.url);
    if (!response.ok) {
      throw new Error(`Failed to download Gradio audio: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error('Downloaded audio file is empty');
    }
    const tmpPath = destPath + '.tmp';
    await writeFile(tmpPath, buffer);
    const { rename } = await import('fs/promises');
    await rename(tmpPath, destPath);
    return;
  }

  throw new Error('Gradio file object has neither path nor url');
}

// ---------------------------------------------------------------------------
// Generation types & interfaces (unchanged public API)
// ---------------------------------------------------------------------------

export interface GenerationParams {
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
  enhance?: boolean;
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

interface GenerationResult {
  audioUrls: string[];
  duration: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  status: string;
}

interface JobStatus {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  queuePosition?: number;
  etaSeconds?: number;
  progress?: number;
  stage?: string;
  result?: GenerationResult;
  error?: string;
}

interface ActiveJob {
  params: GenerationParams;
  startTime: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  taskId?: string;
  result?: GenerationResult;
  error?: string;
  processPromise?: Promise<void>;
  rawResponse?: unknown;
  queuePosition?: number;
  progress?: number;
  stage?: string;
  cancelled?: boolean;
  /** Set when Gradio pre-predict is logged â€” used for stall detection. */
  prePredictAt?: number;
}

const activeJobs = new Map<string, ActiveJob>();

// Periodic cleanup of old jobs (every 10 minutes, remove jobs older than 1 hour)
setInterval(() => cleanupOldJobs(3600000), 600000);

// Job queue for sequential processing (GPU can only handle one job at a time)
const jobQueue: string[] = [];
let isProcessingQueue = false;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          try { onTimeout?.(); } catch { /* ignore */ }
          reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function gradioPredictTimeoutMs(params: GenerationParams): number {
  const envMs = Number(process.env.PHOENIX_GRADIO_PREDICT_TIMEOUT_MS || process.env.ACESTEP_GRADIO_PREDICT_TIMEOUT_MS || 0);
  if (Number.isFinite(envMs) && envMs > 0) return envMs;
  const duration = Number(params.duration) || 120;
  const steps = Number(params.inferenceSteps) || 8;
  const turbo = !!(params.ditModel && /turbo/i.test(params.ditModel));
  // Turbo Create wall-clock is ~8â€“15s (outer ~20â€“30s). Do NOT babysit hung turbo for minutes.
  // Quality / non-turbo keeps the longer budget.
  if (turbo) {
    return Math.min(30_000, Math.max(20_000, 20_000 + Math.max(0, duration - 30) * 50));
  }
  const base = 180_000;
  return Math.min(1_200_000, Math.max(base, base + duration * 2000 + steps * 5000));
}


// Health check - verify Gradio app is reachable
export async function checkSpaceHealth(): Promise<boolean> {
  return isGradioAvailable();
}

// ---------------------------------------------------------------------------
// Model switching Ã¢â‚¬â€ call /v1/init to change the active DiT model
// ---------------------------------------------------------------------------

/** Last DiT model we successfully targeted (engine /v1/models often returns "unknown"). */
let lastRequestedDitModel: string | null = null;

const TURBO_STEPS_CAP = 8;
const PREFERRED_NON_TURBO = 'acestep-v15-sft';
const FALLBACK_NON_TURBO = 'acestep-v15-base';

function isTurboDitModel(model?: string | null): boolean {
  return !!model && model.toLowerCase().includes('turbo');
}

function checkpointDirFor(model: string): string {
  return path.join(ENGINE_DIR, 'checkpoints', model);
}

function isCheckpointOnDisk(model: string): boolean {
  const engineId = toEngineModelId(model);
  const phoenixId = toPhoenixModelId(model);
  // Prefer engine folder; also accept phoenix-* junction if present
  let dir = checkpointDirFor(engineId);
  if (!existsSync(dir) && phoenixId !== engineId) {
    dir = checkpointDirFor(phoenixId);
  }
  if (!existsSync(dir)) return false;
  // Prefer a real weight file if present; otherwise accept non-empty dir with config.json
  try {
    const entries = readdirSync(dir) as string[];
    if (entries.some((e) => /\.(safetensors|bin|pt|ckpt)$/i.test(e))) return true;
    return entries.includes('config.json');
  } catch {
    return false;
  }
}

function resolveNonTurboDitModel(): string {
  if (isCheckpointOnDisk(PREFERRED_NON_TURBO)) return PREFERRED_NON_TURBO;
  if (isCheckpointOnDisk(FALLBACK_NON_TURBO)) return FALLBACK_NON_TURBO;
  return PREFERRED_NON_TURBO;
}

/**
 * If turbo + high steps, force a non-turbo DiT so engine turbo clamp (infer_steps>8Ã¢â€ â€™8) does not apply.
 * Mutates params in place. Does NOT remove the engine clamp Ã¢â‚¬â€ wrong architecture.
 */
function enforceNonTurboForHighSteps(params: GenerationParams): void {
  if (params.ditModel) params.ditModel = toEngineModelId(params.ditModel);
  const steps = params.inferenceSteps ?? 8;
  if (steps <= TURBO_STEPS_CAP) return;
  if (!isTurboDitModel(params.ditModel) && params.ditModel) return;

  const target = resolveNonTurboDitModel();
  if (isTurboDitModel(params.ditModel) || !params.ditModel) {
    console.log(
      `[Model] inferenceSteps=${steps} with turbo/missing ditModel '${params.ditModel ?? '(none)'}' Ã¢â€ â€™ forcing '${target}'`,
    );
    params.ditModel = target;
  }
}

async function getActiveModel(): Promise<string | null> {
  // Prefer our last successful request Ã¢â‚¬â€ Gradio /v1/models often returns name "unknown"
  if (lastRequestedDitModel) return lastRequestedDitModel;
  try {
    const res = await fetch(`${ENGINE_API}/v1/models`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    const models = data?.data?.models || data?.models || [];
    const name = models[0]?.name || null;
    if (name && name !== 'unknown') return name;
    return null;
  } catch {
    return null;
  }
}

/**
 * Attempt to switch DiT via /v1/init when available.
 * This Gradio build often 404s /v1/init Ã¢â‚¬â€ do NOT hard-fail; boot config_path must match.
 */

function readEngineBootConfig(): string | null {
  try {
    const statusPath = path.join(ENGINE_DIR, 'phoenix-engine-status.json');
    if (!existsSync(statusPath)) return null;
    const st = JSON.parse(readFileSync(statusPath, 'utf8')) as { config_path?: string };
    return st?.config_path ? toEngineModelId(String(st.config_path)) : null;
  } catch {
    return null;
  }
}

function writeEngineBootConfig(configPath: string, isTurbo: boolean): void {
  try {
    const statusPath = path.join(ENGINE_DIR, 'phoenix-engine-status.json');
    const payload = {
      config_path: configPath,
      is_turbo: isTurbo,
      updated_at: new Date().toLocaleString(),
    };
    writeFileSync(statusPath, JSON.stringify(payload));
  } catch (e) {
    console.warn('[Model] failed to write phoenix-engine-status.json', e);
  }
}

/** Restart Phoenix Engine with --config_path matching the Quality chip (boot-only DiT select). */
export async function ensureEngineBootConfig(ditModel: string): Promise<{ restarted: boolean; configPath: string }> {
  const wanted = toEngineModelId(ditModel);
  const phoenixId = toPhoenixModelId(wanted);
  const boot = readEngineBootConfig();
  if (boot === wanted) {
    lastRequestedDitModel = wanted;
    return { restarted: false, configPath: phoenixId };
  }

  if (!isCheckpointOnDisk(wanted)) {
    throw new Error(
      `Phoenix DiT checkpoint '${phoenixId}' is not on disk under ${ENGINE_DIR}/checkpoints. ` +
      `Download it, then retry.`,
    );
  }

  console.log(`[Model] Boot DiT mismatch (status=${boot ?? 'none'}, wanted=${wanted}) â€” restarting Phoenix Engine...`);

  // Fail in-flight jobs + free Gradio slot BEFORE taskkill (orphaned await wedges HOL otherwise)
  for (const [jid, j] of activeJobs.entries()) {
    if (j.status === 'queued' || j.status === 'running') {
      j.status = 'failed';
      j.error = 'Phoenix Engine restarting for DiT config switch';
      j.stage = 'Failed';
      j.cancelled = true;
    }
  }
  jobQueue.length = 0;
  isProcessingQueue = false;
  resetGradioClient();

  try {
    const out = execSync('netstat -ano', { encoding: 'utf-8' });
    const pids = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      if (!/:8001\s/.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* ignore */ }
    }
  } catch (e) {
    console.warn('[Model] netstat/taskkill failed', e);
  }

  await new Promise((r) => setTimeout(r, 2000));

  const launcher = process.env.PHOENIX_ENGINE_LAUNCHER || 'C:\\Users\\orchi\\launch_phoenix_engine_noquant.py';
  const python = resolvePythonPath(ENGINE_DIR);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ACESTEP_CONFIG_PATH: phoenixId,
    PHOENIX_ENGINE_CONFIG_PATH: phoenixId,
    ACESTEP_FORCE_LM_4B: 'true',
    ACESTEP_OFFLOAD_TO_CPU: 'false',
    ACESTEP_OFFLOAD_DIT_TO_CPU: 'false',
  };
  const tryIds = [phoenixId, toEngineModelId(phoenixId), toPhoenixModelId(phoenixId)];
  for (const id of tryIds) {
    if (existsSync(path.join(ENGINE_DIR, 'checkpoints', id))) {
      env.ACESTEP_CONFIG_PATH = id;
      env.PHOENIX_ENGINE_CONFIG_PATH = id;
      break;
    }
  }

  spawn(python, [launcher], {
    cwd: ENGINE_DIR,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();

  writeEngineBootConfig(String(env.ACESTEP_CONFIG_PATH), /turbo/i.test(String(env.ACESTEP_CONFIG_PATH)));

  const deadline = Date.now() + 240_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ENGINE_API}/config`);
      if (res.ok) { ready = true; break; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!ready) {
    throw new Error(`Phoenix Engine did not become ready after restart for ${phoenixId}`);
  }

  resetGradioClient();
  lastRequestedDitModel = wanted;
  console.log(`[Model] Phoenix Engine ready with boot config ${env.ACESTEP_CONFIG_PATH}`);
  return { restarted: true, configPath: toPhoenixModelId(String(env.ACESTEP_CONFIG_PATH)) };
}

async function switchModelIfNeeded(ditModel: string): Promise<void> {
  ditModel = toEngineModelId(ditModel);
  const activeModel = await getActiveModel();
  if (activeModel === ditModel) {
    console.log(`[Model] Already targeting '${ditModel}' (tracked active)`);
    return;
  }

  if (!isCheckpointOnDisk(ditModel)) {
    const phoenixId = toPhoenixModelId(ditModel);
    const hint = `Phoenix DiT checkpoint '${phoenixId}' is not on disk. ` +
      `Download the matching Phoenix Engine checkpoint for ${phoenixId}, ` +
      `then restart Phoenix Engine with --config_path ${phoenixId}.`;
    console.error(`[Model] missing engine folder ${checkpointDirFor(ditModel)} (UI id ${phoenixId})`);
    throw new Error(hint);
  }

  console.log(`[Model] Switching from '${activeModel ?? 'unknown'}' to '${ditModel}'`);
  try {
    const res = await fetch(`${ENGINE_API}/v1/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ditModel, init_llm: false }),
    });

    if (res.ok) {
      lastRequestedDitModel = ditModel;
      console.log(`[Model] Switched to '${ditModel}' via /v1/init`);
      return;
    }

    if (res.status === 404) {
      // Gradio portable build: no runtime /v1/init â€” restart with matching --config_path when needed.
      const boot = readEngineBootConfig();
      if (boot && boot === ditModel) {
        lastRequestedDitModel = ditModel;
        console.log(`[Model] /v1/init 404 but boot status already '${ditModel}'`);
        return;
      }
      console.warn(`[Model] /v1/init 404; ensuring boot config_path=${ditModel}`);
      await ensureEngineBootConfig(ditModel);
      return;
    }

    const err = await res.text().catch(() => '');
    throw new Error(`Model switch to '${toPhoenixModelId(ditModel)}' failed: ${res.status} ${err}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('404') || /fetch failed|ECONNREFUSED/i.test(msg)) {
      lastRequestedDitModel = ditModel;
      console.warn(`[Model] /v1/init unreachable (${msg}); continuing with requested '${ditModel}' (boot config_path must match).`);
      return;
    }
    throw e;
  }
}

// Discover endpoints (for compatibility)
export async function discoverEndpoints(): Promise<unknown> {
  return { provider: 'phoenix-engine-gradio', endpoint: ENGINE_API };
}

// Reset client Ã¢â‚¬â€ forces Gradio reconnection on next request
export function resetClient(): void {
  resetGradioClient();
}

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    while (jobQueue.length > 0) {
      const jobId = jobQueue[0];
      const job = activeJobs.get(jobId);

      if (job && job.cancelled) {
        job.status = 'failed';
        job.error = job.error || 'Cancelled';
        job.stage = 'Failed';
      } else if (job && (job.status === 'queued' || job.status === 'running')) {
        try {
          await processGeneration(jobId, job.params, job);
        } catch (error) {
          console.error(`Queue processing error for ${jobId}:`, error);
          if (job.status === 'queued' || job.status === 'running') {
            job.status = 'failed';
            job.error = error instanceof Error ? error.message : 'Queue processing failed';
            job.stage = 'Failed';
          }
        }
      }

      // Remove by jobId (ensure-dit may clear+requeue; never blind-shift wrong head)
      const idx = jobQueue.indexOf(jobId);
      if (idx >= 0) jobQueue.splice(idx, 1);

      jobQueue.forEach((id, index) => {
        const queuedJob = activeJobs.get(id);
        if (queuedJob) {
          queuedJob.queuePosition = index + 1;
        }
      });
    }
  } finally {
    isProcessingQueue = false;
  }
}

// Submit generation job to queue
export async function generateMusicViaAPI(params: GenerationParams): Promise<{ jobId: string }> {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const job: ActiveJob = {
    params,
    startTime: Date.now(),
    status: 'queued',
    queuePosition: jobQueue.length + 1,
  };

  activeJobs.set(jobId, job);
  jobQueue.push(jobId);

  console.log(`Job ${jobId}: Queued at position ${job.queuePosition}`);

  // Start processing the queue (will be a no-op if already processing)
  processQueue().catch(err => console.error('Queue processing error:', err));

  return { jobId };
}

// ---------------------------------------------------------------------------
// processGeneration Ã¢â‚¬â€ Gradio primary, Python spawn fallback
// ---------------------------------------------------------------------------

async function processGeneration(
  jobId: string,
  params: GenerationParams,
  job: ActiveJob,
): Promise<void> {
  if (job.cancelled) {
    job.status = 'failed';
    job.error = 'Cancelled';
    return;
  }
  // Stay queued until Gradio pre-predict â€” avoids UI/DB "running/Generating" with no engine progress
  job.status = 'queued';
  job.stage = 'Startingâ€¦';

  // Server-side safety: turbo + steps>8 Ã¢â€ â€™ force non-turbo DiT (engine still has its own clamp)
  enforceNonTurboForHighSteps(params);
  // Boundary: translate Phoenix IDs Ã¢â€ â€™ engine acestep-* before Gradio/python
  if (params.ditModel) params.ditModel = toEngineModelId(params.ditModel);
  if (params.lmModel) params.lmModel = toEngineModelId(params.lmModel);

  // Guard: cover/audio2audio requires a source or audio codes
  if ((params.taskType === 'cover' || params.taskType === 'audio2audio') && !params.sourceAudioUrl && !params.audioCodes) {
    job.status = 'failed';
    job.error = `task_type='${params.taskType}' requires a source audio or audio codes`;
    return;
  }

  // Try Gradio first
  const gradioUp = await isGradioAvailable();
  if (gradioUp) {
    try {
      await processGenerationViaGradio(jobId, params, job);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Job ${jobId}: Gradio generation failed (no Python fallback while Gradio is up)`, error);
      job.status = 'failed';
      job.error = `Gradio generation failed: ${msg}`;
      job.stage = 'Failed';
      return;
    }
  }

  // Python spawn only when Gradio is completely unavailable
  await processGenerationViaPython(jobId, params, job);
}
async function processGenerationViaGradio(
  jobId: string,
  params: GenerationParams,
  job: ActiveJob,
): Promise<void> {
  // Switch DiT model if a specific one was requested (engine id only)
  if (params.ditModel) {
    params.ditModel = toEngineModelId(params.ditModel);
    job.stage = `Loading model ${params.ditModel}...`;
    await switchModelIfNeeded(params.ditModel);
  }
  if (params.lmModel) params.lmModel = toEngineModelId(params.lmModel);

  // Turbo must never run with SFT LoRA loaded
  if (isTurboDitModel(params.ditModel)) {
    await ensureLoraOffForTurbo(`predict ${jobId} dit=${params.ditModel}`);
  }

  const client = await getGradioClient();
  setInFlightGradioClient(client);
  const args = await buildGradioArgs(params);

  const caption = params.style || 'pop music';
  const prompt = params.customMode ? caption : (params.songDescription || caption);

  console.log(`Job ${jobId}: Using Gradio /generation_wrapper`, {
    bpm: params.bpm,
    thinkingForced: !!(params.bpm && params.bpm > 0),
    prompt: (args[0] as string)?.slice?.(0, 80) ?? prompt.slice(0, 50),
    duration: params.duration,
    batchSize: params.batchSize,
    ditModel: params.ditModel,
    inferenceStepsParam: params.inferenceSteps,
    args6_ditSteps: args[6],
    args24_shift: args[24],
    args25_inferMethod: args[25],
    args18_audioCover: args[18],
      args19_coverNoise: args[19],
      args26_customTimesteps: args[26],
  });
  try {
    const fs = await import('fs');
    void appendFile('E:/Phoenix-Music-Maker-UI/server/dit-steps-debug.log', JSON.stringify({
        t: new Date().toISOString(),
        phase: 'pre-predict',
        jobId,
        ditModel: params.ditModel,
        inferenceStepsParam: params.inferenceSteps,
        args6_ditSteps: args[6],
        args24_shift: args[24],
        args25_inferMethod: args[25],
        args18_audioCover: args[18],
      args19_coverNoise: args[19],
      args26_customTimesteps: args[26],
        duration: params.duration,
        argsLength: args.length,
      }) + '\n',
    ).catch(() => {});
  } catch { /* ignore */ }

  job.prePredictAt = Date.now();
  job.stage = 'Generating music via Gradio...';
  job.status = 'running';

  // predict() blocks until generation is complete â€” MUST timeout + hardClose on stall
  const predictMs = gradioPredictTimeoutMs(params);
  let result;
  try {
    result = await withTimeout(
      client.predict('/generation_wrapper', args),
      predictMs,
      `Gradio predict ${jobId}`,
      () => {
        console.log(`[Gradio] aborted predict for ${jobId}, force-closing sockets`);
        forceCloseGradioSockets();
        const j = activeJobs.get(jobId);
        if (j && (j.status === 'queued' || j.status === 'running')) {
          j.status = 'failed';
          j.error = `Gradio predict timed out after ${Math.round(predictMs / 1000)}s`;
          j.stage = 'Failed';
        }
        isProcessingQueue = false;
        if (jobQueue.length > 0) {
          void processQueue();
        }
      },
    );
  } catch (predictErr) {
    console.error(`[Gradio] predict failed/timeout for ${jobId}:`, predictErr);
    setInFlightGradioClient(null);
    forceCloseGradioSockets();
    resetGradioClient();
    const j = activeJobs.get(jobId);
    if (j && (j.status === 'queued' || j.status === 'running')) {
      j.status = 'failed';
      j.error = predictErr instanceof Error ? predictErr.message : 'Gradio predict failed';
      j.stage = 'Failed';
    }
    isProcessingQueue = false;
    if (jobQueue.length > 0) {
      void processQueue();
    }
    throw predictErr;
  }
  setInFlightGradioClient(null);
  const data = result.data as unknown[];

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Gradio returned unexpected data format: ${typeof data}`);
  }

  // Extract audio files from the result
  // Outputs 0-7: individual audio samples (filepath objects)
  // Output 8: "All Generated Files" as list[filepath]
  // Output 9: "Generation Details" (string)
  // Output 10: "Generation Status" (string)
  // Output 11: "Seed" (string)
  const allFiles = data[8]; // list of file objects
  const genDetails = data[9] as string | undefined;
  const genStatus = data[10] as string | undefined;
  try {
    const fs = await import('fs');
    void appendFile('E:/Phoenix-Music-Maker-UI/server/dit-steps-debug.log', JSON.stringify({
        t: new Date().toISOString(),
        phase: 'post-predict',
        jobId,
        ditModel: params.ditModel,
        inferenceStepsParam: params.inferenceSteps,
        args6_ditSteps: args[6],
        genStatus: typeof genStatus === 'string' ? genStatus.slice(0, 500) : genStatus,
        genDetails: typeof genDetails === 'string' ? genDetails.slice(0, 1500) : genDetails,
      }) + '\n',
    ).catch(() => {});
  } catch { /* ignore */ }

  // Collect audio file objects Ã¢â‚¬â€ prefer the "All Generated Files" list
  let audioFileObjects: Array<{ url?: string; path?: string; orig_name?: string }> = [];

  if (Array.isArray(allFiles) && allFiles.length > 0) {
    audioFileObjects = allFiles.filter(
      (f: any) => f && (f.path || f.url) && isAudioFile(f.orig_name || f.path || '')
    );
  }

  // Fallback: check individual sample outputs (indices 0-7)
  if (audioFileObjects.length === 0) {
    for (let i = 0; i < 8; i++) {
      const fileObj = data[i] as any;
      if (fileObj && (fileObj.path || fileObj.url)) {
        audioFileObjects.push(fileObj);
      }
    }
  }

  if (audioFileObjects.length === 0) {
    throw new Error(`Gradio generation returned no audio files. Status: ${genStatus || 'unknown'}. Details: ${genDetails || 'none'}`);
  }

  // Download audio files to local storage
  const audioUrls: string[] = [];
  let actualDuration = 0;
  const audioFormat = params.audioFormat ?? 'mp3';

  for (const fileObj of audioFileObjects) {
    const origName = fileObj.orig_name || fileObj.path || '';
    const ext = origName.includes('.flac') ? '.flac' : `.${audioFormat}`;
    const filename = `${jobId}_${audioUrls.length}${ext}`;
    const destPath = path.join(AUDIO_DIR, filename);

    await downloadGradioAudioFile(fileObj, destPath);

    if (audioUrls.length === 0) {
      actualDuration = getAudioDuration(destPath);
    }

    audioUrls.push(`/audio/${filename}`);
  }

  // Parse metadata from generation details if available
  const metas = parseGenerationDetails(genDetails);

  const finalDuration = actualDuration > 0
    ? actualDuration
    : (metas.duration || params.duration || 0);

  if (job.cancelled) {
    job.status = 'failed';
    job.error = 'Cancelled';
    return;
  }
  job.status = 'succeeded';
  job.result = {
    audioUrls,
    duration: finalDuration,
    bpm: metas.bpm || params.bpm,
    keyScale: metas.keyScale || params.keyScale,
    timeSignature: metas.timeSignature || params.timeSignature,
    status: 'succeeded',
  };
  job.rawResponse = { genDetails, genStatus };
  console.log(`Job ${jobId}: Completed via Gradio with ${audioUrls.length} audio files`);
}

function isAudioFile(name: string): boolean {
  return /\.(mp3|flac|wav|ogg|m4a)$/i.test(name);
}

function parseGenerationDetails(details: string | undefined): {
  bpm?: number;
  duration?: number;
  keyScale?: string;
  timeSignature?: string;
} {
  if (!details) return {};
  try {
    // Generation details may contain key-value pairs
    const bpmMatch = details.match(/BPM:\s*(\d+)/i);
    const durationMatch = details.match(/Duration:\s*([\d.]+)/i);
    const keyMatch = details.match(/Key:\s*([A-G][#b]?\s*(?:major|minor))/i);
    const timeMatch = details.match(/Time Signature:\s*(\d+\/\d+)/i);
    return {
      bpm: bpmMatch ? parseInt(bpmMatch[1]) : undefined,
      duration: durationMatch ? parseFloat(durationMatch[1]) : undefined,
      keyScale: keyMatch ? keyMatch[1] : undefined,
      timeSignature: timeMatch ? timeMatch[1] : undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Python spawn fallback (kept from original for offline/fallback use)
// ---------------------------------------------------------------------------

async function processGenerationViaPython(
  jobId: string,
  params: GenerationParams,
  job: ActiveJob,
): Promise<void> {
  const caption = params.style || 'pop music';
  const prompt = params.customMode ? caption : (params.songDescription || caption);
  const lyrics = params.instrumental ? '' : (params.lyrics || '');

  console.log(`Job ${jobId}: Using Python spawn (Gradio not available)`, {
    prompt: prompt.slice(0, 50),
    lyricsPreview: lyrics.slice(0, 50),
    duration: params.duration,
    batchSize: params.batchSize,
  });

  try {
    const jobOutputDir = path.join(ENGINE_DIR, 'output', jobId);
    await mkdir(jobOutputDir, { recursive: true });

    const durationToSend = params.duration && params.duration > 0 ? params.duration : 60;
    const args = [
      '--prompt', prompt,
      '--duration', String(durationToSend),
      '--batch-size', String(params.batchSize ?? 1),
      '--infer-steps', String(params.inferenceSteps ?? 8),
      '--guidance-scale', String(params.guidanceScale ?? 10.0),
      '--audio-format', params.audioFormat ?? 'mp3',
      '--output-dir', jobOutputDir,
      '--json',
    ];

    if (lyrics) args.push('--lyrics', lyrics);
    if (params.instrumental) args.push('--instrumental');
    if (params.bpm && params.bpm > 0) args.push('--bpm', String(params.bpm));
    if (params.keyScale) args.push('--key-scale', params.keyScale);
    if (params.timeSignature) args.push('--time-signature', params.timeSignature);
    if (params.vocalLanguage) args.push('--vocal-language', params.vocalLanguage);
    if (params.seed !== undefined && params.seed >= 0 && !params.randomSeed) args.push('--seed', String(params.seed));
    if (params.shift !== undefined) args.push('--shift', String(params.shift));
    const resolvedTaskType = params.taskType === 'audio2audio' ? 'cover' : params.taskType;
    if (resolvedTaskType && resolvedTaskType !== 'text2music') args.push('--task-type', resolvedTaskType);

    if (params.referenceAudioUrl) {
      args.push('--reference-audio', resolveAudioPath(params.referenceAudioUrl));
    }
    if (params.sourceAudioUrl) {
      args.push('--src-audio', resolveAudioPath(params.sourceAudioUrl));
    }
    if (params.audioCodes) args.push('--audio-codes', params.audioCodes);
    if (params.repaintingStart !== undefined && params.repaintingStart > 0) args.push('--repainting-start', String(params.repaintingStart));
    if (params.repaintingEnd !== undefined && params.repaintingEnd > 0) args.push('--repainting-end', String(params.repaintingEnd));
    if (params.taskType === 'cover' || params.taskType === 'repaint' || params.sourceAudioUrl) {
      args.push('--audio-cover-strength', String(params.audioCoverStrength ?? 1.0));
    } else if (params.audioCoverStrength !== undefined && params.audioCoverStrength !== 1.0) {
      args.push('--audio-cover-strength', String(params.audioCoverStrength));
    }
    if (params.instruction) args.push('--instruction', params.instruction);
    if (params.thinking) args.push('--thinking');
    if (params.lmTemperature !== undefined) args.push('--lm-temperature', String(params.lmTemperature));
    if (params.lmCfgScale !== undefined) args.push('--lm-cfg-scale', String(params.lmCfgScale));
    if (params.lmTopK !== undefined && params.lmTopK > 0) args.push('--lm-top-k', String(params.lmTopK));
    if (params.lmTopP !== undefined) args.push('--lm-top-p', String(params.lmTopP));
    if (params.lmNegativePrompt) args.push('--lm-negative-prompt', params.lmNegativePrompt);
    // Note: --lm-backend and --lm-model are not supported by simple_generate.py
    if (params.useCotMetas === false) args.push('--no-cot-metas');
    if (params.useCotCaption === false) args.push('--no-cot-caption');
    if (params.useCotLanguage === false) args.push('--no-cot-language');
    if (params.useAdg) args.push('--use-adg');
    if (params.cfgIntervalStart !== undefined && params.cfgIntervalStart > 0) args.push('--cfg-interval-start', String(params.cfgIntervalStart));
    if (params.cfgIntervalEnd !== undefined && params.cfgIntervalEnd < 1.0) args.push('--cfg-interval-end', String(params.cfgIntervalEnd));

    const result = await runPythonGeneration(args);

    if (!result.success) {
      throw new Error(result.error || 'Generation failed');
    }

    if (!result.audio_paths || result.audio_paths.length === 0) {
      throw new Error('No audio files generated');
    }

    const audioUrls: string[] = [];
    let actualDuration = 0;
    for (const srcPath of result.audio_paths) {
      const ext = srcPath.includes('.flac') ? '.flac' : '.mp3';
      const filename = `${jobId}_${audioUrls.length}${ext}`;
      const destPath = path.join(AUDIO_DIR, filename);

      await mkdir(AUDIO_DIR, { recursive: true });
      await copyFile(srcPath, destPath);

      if (audioUrls.length === 0) {
        actualDuration = getAudioDuration(destPath);
      }

      audioUrls.push(`/audio/${filename}`);
    }

    try {
      await rm(jobOutputDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn(`Job ${jobId}: Failed to cleanup output dir`, cleanupError);
    }

    const finalDuration = actualDuration > 0 ? actualDuration : (params.duration && params.duration > 0 ? params.duration : 0);

    if (job.cancelled) {
      job.status = 'failed';
      job.error = 'Cancelled';
      return;
    }
    job.status = 'succeeded';
    job.result = {
      audioUrls,
      duration: finalDuration,
      bpm: params.bpm,
      keyScale: params.keyScale,
      timeSignature: params.timeSignature,
      status: 'succeeded',
    };
    job.rawResponse = result;
    console.log(`Job ${jobId}: Completed via Python in ${result.elapsed_seconds?.toFixed(1)}s with ${audioUrls.length} audio files`);

  } catch (error) {
    console.error(`Job ${jobId}: Generation failed`, error);
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : 'Generation failed';

    try {
      const jobOutputDir = path.join(ENGINE_DIR, 'output', jobId);
      await rm(jobOutputDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

interface PythonResult {
  success: boolean;
  audio_paths?: string[];
  elapsed_seconds?: number;
  error?: string;
}

function runPythonGeneration(scriptArgs: string[], timeoutMs = 600000): Promise<PythonResult> {
  return new Promise((resolve) => {
    const pythonPath = resolvePythonPath(ENGINE_DIR);
    const args = [PYTHON_SCRIPT, ...scriptArgs];

    const proc = spawn(pythonPath, args, {
      cwd: ENGINE_DIR,
      env: {
        ...process.env,
        ACESTEP_PATH: ENGINE_DIR,
      },
    });

    // Kill process after timeout (default 10 minutes)
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
      resolve({ success: false, error: `Generation timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          console.log(`[Phoenix Engine] ${line}`);
        }
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ success: false, error: stderr || `Process exited with code ${code}` });
        return;
      }

      const lines = stdout.split('\n').filter(l => l.trim());
      const jsonLine = lines.find(l => l.startsWith('{'));

      if (!jsonLine) {
        resolve({ success: false, error: 'No JSON output from generation script' });
        return;
      }

      try {
        const result = JSON.parse(jsonLine);
        resolve(result);
      } catch {
        resolve({ success: false, error: 'Invalid JSON from generation script' });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}

// ---------------------------------------------------------------------------
// Job status (simplified Ã¢â‚¬â€ no more REST polling for progress)
// ---------------------------------------------------------------------------

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const job = activeJobs.get(jobId);

  if (!job) {
    return {
      status: 'failed',
      error: 'Job not found',
    };
  }

  if (job.cancelled) {
    return {
      status: 'failed',
      error: 'Cancelled',
    };
  }

  // Hung after pre-predict with no completion â€” fail + hardClose (pillar C stall)
  const STALL_MS = (job.params?.ditModel && /turbo/i.test(String(job.params.ditModel))) ? 25_000 : 180_000;
  if (
    (job.status === 'running' || job.status === 'queued') &&
    job.prePredictAt &&
    Date.now() - job.prePredictAt > STALL_MS &&
    !job.result
  ) {
    console.warn(`[Gradio] stall detected for ${jobId} after pre-predict`);
    forceCloseGradioSockets();
    job.status = 'failed';
    job.error = 'Gradio predict stalled after pre-predict';
    job.stage = 'Failed';
    isProcessingQueue = false;
    if (jobQueue.length > 0) {
      void processQueue();
    }
    return { status: 'failed', error: job.error };
  }

  if (job.status === 'succeeded' && job.result) {
    return {
      status: 'succeeded',
      result: job.result,
    };
  }

  if (job.status === 'failed') {
    return {
      status: 'failed',
      error: job.error || 'Generation failed',
    };
  }

  const elapsed = Math.floor((Date.now() - job.startTime) / 1000);

  if (job.status === 'queued') {
    return {
      status: job.status,
      queuePosition: job.queuePosition,
      etaSeconds: (job.queuePosition || 1) * 180,
    };
  }

  // Running Ã¢â‚¬â€ Gradio handles its own queue, we just report estimated time
  return {
    status: job.status,
    etaSeconds: Math.max(0, 180 - elapsed),
    progress: job.progress,
    stage: job.stage,
  };
}

// Get raw response for debugging
export function getJobRawResponse(jobId: string): unknown | null {
  const job = activeJobs.get(jobId);
  return job?.rawResponse || null;
}

// ---------------------------------------------------------------------------
// Audio helpers (unchanged)
// ---------------------------------------------------------------------------

export async function getAudioStream(audioPath: string): Promise<Response> {
  if (audioPath.startsWith('http')) {
    return fetch(audioPath);
  }

  if (audioPath.startsWith('/audio/')) {
    const localPath = path.join(AUDIO_DIR, audioPath.replace('/audio/', ''));
    try {
      const buffer = await readFile(localPath);
      const ext = localPath.endsWith('.flac') ? 'flac' : 'mpeg';
      return new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': `audio/${ext}` }
      });
    } catch (err) {
      console.error('Failed to read local audio file:', localPath, err);
      return new Response(null, { status: 404 });
    }
  }

  // Absolute path Ã¢â‚¬â€ try reading directly from disk (Gradio output files)
  if (audioPath.startsWith('/')) {
    try {
      const buffer = await readFile(audioPath);
      const ext = audioPath.endsWith('.flac') ? 'flac' : audioPath.endsWith('.wav') ? 'wav' : 'mpeg';
      return new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': `audio/${ext}` }
      });
    } catch {
      // Fall through to Gradio API
    }
  }

  const url = `${ENGINE_API}/v1/audio?path=${encodeURIComponent(audioPath)}`;
  console.log('Fetching audio from:', url);
  return fetch(url);
}

export async function downloadAudio(remoteUrl: string, songId: string): Promise<string> {
  await mkdir(AUDIO_DIR, { recursive: true });

  const response = await getAudioStream(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const ext = remoteUrl.includes('.flac') ? '.flac' : '.mp3';
  const filename = `${songId}${ext}`;
  const filepath = path.join(AUDIO_DIR, filename);

  await writeFile(filepath, Buffer.from(buffer));
  console.log(`Downloaded audio to ${filepath}`);

  return `/audio/${filename}`;
}

export async function downloadAudioToBuffer(remoteUrl: string): Promise<{ buffer: Buffer; size: number }> {
  const response = await getAudioStream(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return { buffer, size: buffer.length };
}

/** Cancel a queued/running engine job. Queued jobs are dropped; running jobs discard their result. */
export function cancelEngineJob(jobId: string): boolean {
  const job = activeJobs.get(jobId);
  // ALWAYS hard-close Gradio sockets (ghost ESTABLISHED after cancel / missing job)
  console.log(`[Gradio] hard-closed on cancel ${jobId}`);
  forceCloseGradioSockets();
  resetGradioClient();
  isProcessingQueue = false;

  if (!job) {
    if (jobQueue.length > 0) {
      void processQueue();
    }
    return false;
  }
  job.cancelled = true;
  if (job.status === 'queued' || job.status === 'running') {
    job.status = 'failed';
    job.error = 'Cancelled';
    job.stage = 'Failed';
  }
  const qIdx = jobQueue.indexOf(jobId);
  if (qIdx >= 0) jobQueue.splice(qIdx, 1);
  jobQueue.forEach((id, index) => {
    const queuedJob = activeJobs.get(id);
    if (queuedJob) queuedJob.queuePosition = index + 1;
  });
  if (jobQueue.length > 0) {
    void processQueue();
  }
  return true;
}



/** Cached ESTABâ†’:8001 probe â€” never execSync on hot/boot path (was stalling auth). */
let estabCache: { at: number; value: boolean } | null = null;
const ESTAB_CACHE_MS = 1000;

async function hasEstablishedGradioSockets(): Promise<boolean> {
  const now = Date.now();
  if (estabCache && now - estabCache.at < ESTAB_CACHE_MS) {
    return estabCache.value;
  }
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('netstat', ['-ano'], {
      timeout: 1500,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    const value = String(stdout)
      .split(/\r?\n/)
      .some((line) => /:8001\b/.test(line) && /ESTABLISHED/i.test(line));
    estabCache = { at: now, value };
    return value;
  } catch {
    estabCache = { at: now, value: false };
    return false;
  }
}


/**
 * On server boot/recycle: clear eternal ghosts, but do NOT false-fail live Creates.
 * - queued/pending age <120s: skip
 * - running age <30s (turbo stall window): skip
 * - any orphan while ESTABLISHEDâ†’:8001: skip (Gradio still has the task)
 * - do NOT use a 360s babysit window
 * - older orphans with no ESTAB: fail `Server recycled â€” job lost`
 */
export async function reconcileOrphanGenerationJobs(): Promise<number> {
  try {
    const result = await pool.query(
      `SELECT id, phoenix_task_id, status, created_at FROM generation_jobs
       WHERE status IN ('pending', 'queued', 'running')`,
    );
    const estab = await hasEstablishedGradioSockets();
    if (estab) {
      console.log('[Boot] ESTABLISHEDâ†’:8001 present â€” skipping orphan reclaim this pass');
      return 0;
    }

    let marked = 0;
    const now = Date.now();
    for (const row of result.rows as Array<{
      id: string;
      phoenix_task_id?: string | null;
      status: string;
      created_at?: string | null;
    }>) {
      const engineId = row.phoenix_task_id;
      if (engineId && activeJobs.has(engineId)) {
        if (!isProcessingQueue && jobQueue.length > 0) {
          void processQueue();
        }
        continue;
      }

      const createdMs = row.created_at ? new Date(row.created_at).getTime() : 0;
      const ageMs = createdMs ? now - createdMs : Number.POSITIVE_INFINITY;

      // Fresh queued â€” worker may still be about to start predict
      if ((row.status === 'queued' || row.status === 'pending') && ageMs < 120_000) {
        console.log(`[Boot] skip young queued orphan ${row.id} age=${Math.round(ageMs / 1000)}s`);
        continue;
      }

      // Fresh running, no ESTAB (checked above): skip if age <120s â€” not a 360s babysit
      if (row.status === 'running' && ageMs < 120_000) {
        console.log(`[Boot] skip young running orphan ${row.id} age=${Math.round(ageMs / 1000)}s`);
        continue;
      }

      await pool.query(
        `UPDATE generation_jobs SET status = 'failed', error = ?, updated_at = datetime('now')
         WHERE id = ? AND status IN ('pending', 'queued', 'running')`,
        ['Server recycled â€” job lost', row.id],
      );
      marked += 1;
      console.warn(`[Boot] orphan generation_job ${row.id} (engine=${engineId || 'none'}, status=${row.status}, age=${Math.round(ageMs / 1000)}s) â†’ failed`);
    }
    if (marked > 0) {
      console.log(`[Boot] marked ${marked} orphan generation_jobs as failed (Server recycled â€” job lost)`);
    } else {
      console.log('[Boot] no orphan generation_jobs reclaimed');
    }
    return marked;
  } catch (e) {
    console.error('[Boot] reconcileOrphanGenerationJobs failed:', e);
    return 0;
  }
}

export function cleanupJob(jobId: string): void {
  activeJobs.delete(jobId);
}

export function cleanupOldJobs(maxAgeMs: number = 3600000): void {
  const now = Date.now();
  for (const [jobId, job] of activeJobs) {
    if (now - job.startTime > maxAgeMs) {
      activeJobs.delete(jobId);
    }
  }
}
