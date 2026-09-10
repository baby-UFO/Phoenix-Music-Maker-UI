import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_AUDIO_DIR = path.join(__dirname, '../../public/audio');

export type ExportFormat = 'wav' | 'mp3' | 'flac' | 'ogg' | 'aac';
export const EXPORT_FORMATS: ExportFormat[] = ['wav', 'mp3', 'flac', 'ogg', 'aac'];

const CONTENT_TYPES: Record<ExportFormat, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
};

export function isExportFormat(v: string): v is ExportFormat {
  return (EXPORT_FORMATS as string[]).includes(v);
}

export function contentTypeFor(format: ExportFormat): string {
  return CONTENT_TYPES[format];
}

/** Resolve /audio/... paths (including nested user folders) to an absolute local path. */
export function resolveLocalAudioPath(audioUrlOrName: string): string | null {
  if (!audioUrlOrName) return null;
  let name = audioUrlOrName.trim();
  if (name.startsWith('http://') || name.startsWith('https://') || name.startsWith('s3://')) {
    return null;
  }
  try {
    // Absolute file path already on disk
    if (path.isAbsolute(name) && fs.existsSync(name)) {
      return name;
    }
  } catch { /* ignore */ }
  if (name.startsWith('/audio/')) name = name.slice('/audio/'.length);
  name = name.replace(/^\/+/, '');
  // Normalize and block path traversal while keeping nested folders (userId/song.flac)
  const full = path.resolve(LOCAL_AUDIO_DIR, name);
  const root = path.resolve(LOCAL_AUDIO_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

/** Ensure we have a local file for ffmpeg: local path, or download remote URL to a temp file. */
export async function materializeAudioForExport(audioUrlOrName: string): Promise<{ path: string; cleanup: boolean }> {
  const local = resolveLocalAudioPath(audioUrlOrName);
  if (local) return { path: local, cleanup: false };

  const src = (audioUrlOrName || '').trim();
  if (!src) throw new Error('No audio URL');

  let fetchUrl = src;
  if (src.startsWith('/')) {
    // Same-origin relative /audio/... that resolveLocal missed — should not happen after path fix
    fetchUrl = `http://127.0.0.1:3001${src}`;
  } else if (!(src.startsWith('http://') || src.startsWith('https://'))) {
    throw new Error('Local audio file not found for export (ffmpeg needs a local file).');
  }

  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`Failed to fetch audio for export (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Downloaded audio is empty');

  const urlPath = fetchUrl.split('?')[0].toLowerCase();
  let ext = 'audio';
  for (const e of ['flac', 'wav', 'mp3', 'ogg', 'aac', 'm4a', 'opus']) {
    if (urlPath.endsWith('.' + e)) { ext = e; break; }
  }
  const tmp = path.join(os.tmpdir(), `phoenix-export-src-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(tmp, buf);
  return { path: tmp, cleanup: true };
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
    case 'aac':
      return [...base, '-c:a', 'aac', '-b:a', '192k', '-f', 'adts', output];
  }
}

export async function convertWithFfmpeg(inputPath: string, format: ExportFormat): Promise<string> {
  const ext = path.extname(inputPath).toLowerCase().replace('.', '');
  if (ext === format) {
    return inputPath; // already desired format
  }

  const tmp = path.join(os.tmpdir(), `phoenix-export-${Date.now()}-${Math.random().toString(36).slice(2)}.${format}`);
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
