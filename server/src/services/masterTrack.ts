/**
 * Phoenix Music Maker — Master Track (FFmpeg LGPL filter chain)
 * Chain: EQ → acompressor → stereotools → alimiter → 2-pass loudnorm
 * Output: *_master.<ext> next to source when local; never overwrites source.
 * Branding: Phoenix Music Maker / PMM / Phoenix Engine only.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOCAL_AUDIO_DIR,
  materializeAudioForExport,
  type ExportFormat,
} from './ffmpegExport.js';

export type MasterPresetId = 'streaming' | 'club' | 'soft';

export interface MasterPreset {
  id: MasterPresetId;
  label: string;
  /** Target integrated loudness (LUFS) */
  I: number;
  /** True peak (dBTP) */
  TP: number;
  /** Loudness range */
  LRA: number;
  description: string;
}

export const MASTER_PRESETS: Record<MasterPresetId, MasterPreset> = {
  streaming: {
    id: 'streaming',
    label: 'Streaming',
    I: -14,
    TP: -1.0,
    LRA: 11,
    description: '−14 LUFS / −1 dBTP — Spotify, YouTube, Apple Music',
  },
  club: {
    id: 'club',
    label: 'Club',
    I: -9.5,
    TP: -1.0,
    LRA: 9,
    description: '−9.5 LUFS / −1 dBTP — louder club / DJ systems',
  },
  soft: {
    id: 'soft',
    label: 'Soft',
    I: -16,
    TP: -1.5,
    LRA: 11,
    description: '−16 LUFS / −1.5 dBTP — gentle / podcast-friendly',
  },
};

export interface MasterKnobParams {
  /** Low shelf gain dB (−12..12), default 0.5 */
  bassDb?: number;
  /** Peaking mid gain dB (−12..12), default 0 */
  midDb?: number;
  /** High shelf gain dB (−12..12), default 1.0 */
  trebleDb?: number;
  /** Compressor threshold dB, default −18 */
  compThreshold?: number;
  /** Compressor ratio, default 2.5 */
  compRatio?: number;
  /** Stereo width 0..2 (1 = unchanged), default 1.15 */
  stereoWidth?: number;
  /** Limiter level / ceiling linear 0..1, default 0.95 */
  limitLevel?: number;
}

export interface MasterRequest {
  preset: MasterPresetId;
  format?: ExportFormat;
  knobs?: MasterKnobParams;
}

export interface LoudnormMeters {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  output_i?: string;
  output_tp?: string;
  output_lra?: string;
  output_thresh?: string;
  normalization_type?: string;
  target_offset?: string;
  measured_I?: string;
  measured_TP?: string;
  measured_LRA?: string;
  measured_thresh?: string;
  offset?: string;
}

export interface MasterResult {
  outputPath: string;
  publicAudioUrl: string | null;
  filename: string;
  meters: LoudnormMeters | null;
  preset: MasterPreset;
  format: ExportFormat;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function buildProcessingChain(knobs: MasterKnobParams = {}): string {
  const bass = clamp(knobs.bassDb ?? 0.5, -12, 12);
  const mid = clamp(knobs.midDb ?? 0, -12, 12);
  const treble = clamp(knobs.trebleDb ?? 1.0, -12, 12);
  const thr = clamp(knobs.compThreshold ?? -18, -40, 0);
  const ratio = clamp(knobs.compRatio ?? 2.5, 1, 20);
  const width = clamp(knobs.stereoWidth ?? 1.15, 0, 2);
  const limit = clamp(knobs.limitLevel ?? 0.95, 0.1, 1);

  // EQ → acompressor → stereotools → alimiter (loudnorm appended by caller)
  const parts = [
    `equalizer=f=100:width_type=h:width=200:g=${bass.toFixed(2)}`,
    `equalizer=f=1000:width_type=q:width=1.0:g=${mid.toFixed(2)}`,
    `equalizer=f=8000:width_type=h:width=2000:g=${treble.toFixed(2)}`,
    `acompressor=threshold=${thr.toFixed(1)}dB:ratio=${ratio.toFixed(2)}:attack=15:release=150:makeup=2`,
    `stereotools=mlev=1:slev=${width.toFixed(3)}:sbal=0:balance_in=0:balance_out=0`,
    `alimiter=level_in=1:level_out=1:limit=${limit.toFixed(3)}:attack=5:release=50:level=0`,
  ];
  return parts.join(',');
}

function runFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

/** Extract loudnorm JSON object printed to stderr. */
export function parseLoudnormJson(stderr: string): LoudnormMeters | null {
  // loudnorm prints a JSON block; find last '{' ... '}' that looks like loudnorm
  const matches = [...stderr.matchAll(/\{[^{}]*"input_i"[^{}]*\}/g)];
  if (!matches.length) {
    // multiline JSON
    const start = stderr.lastIndexOf('{');
    const end = stderr.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const obj = JSON.parse(stderr.slice(start, end + 1));
        if (obj && (obj.input_i !== undefined || obj.measured_I !== undefined)) {
          return obj as LoudnormMeters;
        }
      } catch { /* ignore */ }
    }
    return null;
  }
  try {
    return JSON.parse(matches[matches.length - 1][0]) as LoudnormMeters;
  } catch {
    return null;
  }
}

function codecArgs(format: ExportFormat, output: string): string[] {
  switch (format) {
    case 'wav':
      return ['-acodec', 'pcm_s16le', output];
    case 'mp3':
      return ['-codec:a', 'libmp3lame', '-q:a', '2', output];
    case 'flac':
      return ['-acodec', 'flac', output];
    case 'ogg':
      return ['-codec:a', 'libvorbis', '-q:a', '6', output];
    case 'aac':
      return ['-c:a', 'aac', '-b:a', '192k', '-f', 'adts', output];
    default:
      return ['-acodec', 'pcm_s16le', output];
  }
}

/**
 * Build a sibling *_master path that never equals the source.
 * e.g. song.flac → song_master.wav
 */
export function buildMasterOutputPath(sourcePath: string, format: ExportFormat): string {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));
  // Strip existing _master suffix to avoid song_master_master
  const clean = base.replace(/_master$/i, '');
  let candidate = path.join(dir, `${clean}_master.${format}`);
  if (path.resolve(candidate) === path.resolve(sourcePath)) {
    candidate = path.join(dir, `${clean}_master_out.${format}`);
  }
  // If file exists, add numeric suffix rather than overwrite a previous master optionally —
  // requirement is never overwrite *source*; overwriting prior master of same name is OK for re-render.
  return candidate;
}

/** Map absolute path under LOCAL_AUDIO_DIR to /audio/... public URL. */
export function toPublicAudioUrl(absPath: string): string | null {
  const root = path.resolve(LOCAL_AUDIO_DIR);
  const full = path.resolve(absPath);
  if (full === root || !full.startsWith(root + path.sep)) return null;
  const rel = full.slice(root.length).replace(/\\/g, '/');
  return `/audio${rel.startsWith('/') ? '' : '/'}${rel}`;
}

export async function masterTrack(
  audioUrlOrPath: string,
  req: MasterRequest,
): Promise<MasterResult> {
  const preset = MASTER_PRESETS[req.preset] || MASTER_PRESETS.streaming;
  const format: ExportFormat = req.format || 'wav';
  const knobs = req.knobs || {};
  const processing = buildProcessingChain(knobs);

  const src = await materializeAudioForExport(audioUrlOrPath);
  const srcCleanup = src.cleanup ? src.path : null;

  try {
    // Decide output path: prefer sibling of local source; else temp then copy if possible
    let outputPath: string;
    let publicAudioUrl: string | null = null;

    if (!src.cleanup) {
      outputPath = buildMasterOutputPath(src.path, format);
    } else {
      // Remote/temp source — write under LOCAL_AUDIO_DIR/masters/
      const mastersDir = path.join(LOCAL_AUDIO_DIR, 'masters');
      fs.mkdirSync(mastersDir, { recursive: true });
      const stamp = Date.now();
      outputPath = path.join(mastersDir, `track_${stamp}_master.${format}`);
    }

    // Safety: never write onto source
    if (path.resolve(outputPath) === path.resolve(src.path)) {
      throw new Error('Refusing to overwrite source audio');
    }

    const loudnormMeasure = `loudnorm=I=${preset.I}:TP=${preset.TP}:LRA=${preset.LRA}:print_format=json`;
    const afPass1 = `${processing},${loudnormMeasure}`;

    // Pass 1 — measure
    const pass1 = await runFfmpeg([
      '-y', '-hide_banner', '-i', src.path,
      '-af', afPass1,
      '-f', 'null',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
    ]);
    if (pass1.code !== 0) {
      throw new Error(`ffmpeg master pass1 failed (code ${pass1.code}): ${pass1.stderr.slice(-800)}`);
    }
    const measured = parseLoudnormJson(pass1.stderr);

    let afPass2: string;
    if (measured && measured.input_i !== undefined) {
      const mI = measured.input_i;
      const mTP = measured.input_tp;
      const mLRA = measured.input_lra;
      const mThresh = measured.input_thresh;
      const offset = measured.target_offset ?? '0';
      afPass2 =
        `${processing},` +
        `loudnorm=I=${preset.I}:TP=${preset.TP}:LRA=${preset.LRA}:` +
        `measured_I=${mI}:measured_TP=${mTP}:measured_LRA=${mLRA}:measured_thresh=${mThresh}:` +
        `offset=${offset}:linear=true:print_format=json`;
    } else {
      // Fallback single-pass loudnorm if JSON parse failed
      afPass2 = `${processing},loudnorm=I=${preset.I}:TP=${preset.TP}:LRA=${preset.LRA}:print_format=json`;
    }

    const pass2Args = [
      '-y', '-hide_banner', '-i', src.path,
      '-af', afPass2,
      ...codecArgs(format, outputPath),
    ];
    const pass2 = await runFfmpeg(pass2Args);
    if (pass2.code !== 0 || !fs.existsSync(outputPath)) {
      throw new Error(`ffmpeg master pass2 failed (code ${pass2.code}): ${pass2.stderr.slice(-800)}`);
    }

    const finalMeters = parseLoudnormJson(pass2.stderr) || measured;
    publicAudioUrl = toPublicAudioUrl(outputPath);
    const filename = path.basename(outputPath);

    return {
      outputPath,
      publicAudioUrl,
      filename,
      meters: finalMeters,
      preset,
      format,
    };
  } finally {
    if (srcCleanup) {
      try { fs.unlinkSync(srcCleanup); } catch { /* ignore */ }
    }
  }
}

/** Quick availability check for ffmpeg binary. */
export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    const r = await runFfmpeg(['-version']);
    return r.code === 0 || r.stdout.includes('ffmpeg') || r.stderr.includes('ffmpeg');
  } catch {
    return false;
  }
}
