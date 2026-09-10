import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_AUDIO_DIR = path.join(__dirname, '../../public/audio');

export type ExportFormat = 'wav' | 'mp3' | 'flac' | 'ogg';
export const EXPORT_FORMATS: ExportFormat[] = ['wav', 'mp3', 'flac', 'ogg'];

const CONTENT_TYPES: Record<ExportFormat, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
};

export function isExportFormat(v: string): v is ExportFormat {
  return (EXPORT_FORMATS as string[]).includes(v);
}

export function contentTypeFor(format: ExportFormat): string {
  return CONTENT_TYPES[format];
}

/** Resolve /audio/foo.flac or bare filename to an absolute local path. */
export function resolveLocalAudioPath(audioUrlOrName: string): string | null {
  if (!audioUrlOrName) return null;
  let name = audioUrlOrName.trim();
  if (name.startsWith('http://') || name.startsWith('https://') || name.startsWith('s3://')) {
    return null;
  }
  if (name.startsWith('/audio/')) name = name.slice('/audio/'.length);
  name = name.replace(/^\/+/, '');
  // Prevent path traversal
  name = path.basename(name);
  const full = path.join(LOCAL_AUDIO_DIR, name);
  if (!full.startsWith(LOCAL_AUDIO_DIR)) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

function ffmpegArgs(input: string, output: string, format: ExportFormat): string[] {
  const base = ['-y', '-i', input];
  switch (format) {
    case 'wav':
      return [...base, '-acodec', 'pcm_s16le', output];
    case 'mp3':
      return [...base, '-codec:a', 'libmp3lame', '-q:a', '2', output];
    case 'flac':
      return [...base, '-acodec', 'flac', output];
    case 'ogg':
      return [...base, '-codec:a', 'libvorbis', '-q:a', '6', output];
  }
}

export async function convertWithFfmpeg(inputPath: string, format: ExportFormat): Promise<string> {
  const ext = path.extname(inputPath).toLowerCase().replace('.', '');
  if (ext === format) {
    return inputPath; // already desired format
  }

  const tmp = path.join(os.tmpdir(), `ace-export-${Date.now()}-${Math.random().toString(36).slice(2)}.${format}`);
  const args = ffmpegArgs(inputPath, tmp, format);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(tmp)) resolve();
      else reject(new Error(`ffmpeg failed (code ${code}): ${err.slice(-500)}`));
    });
  });

  return tmp;
}

export function safeDownloadName(title: string | null | undefined, format: ExportFormat): string {
  const base = (title || 'song').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'song';
  return `${base}.${format}`;
}
