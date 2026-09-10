export type DownloadFormat = 'original' | 'wav' | 'mp3' | 'flac' | 'ogg';

export const DOWNLOAD_FORMATS: { id: DownloadFormat; label: string }[] = [
  { id: 'original', label: 'Original' },
  { id: 'wav', label: 'WAV (ffmpeg)' },
  { id: 'mp3', label: 'MP3 (ffmpeg)' },
  { id: 'flac', label: 'FLAC (ffmpeg)' },
  { id: 'ogg', label: 'OGG (ffmpeg)' },
];

function extFromAudioUrl(url: string, blobType?: string): string {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.flac')) return 'flac';
  if (path.endsWith('.wav')) return 'wav';
  if (path.endsWith('.ogg')) return 'ogg';
  if (path.endsWith('.m4a')) return 'm4a';
  if (path.endsWith('.mp3')) return 'mp3';
  if (blobType?.includes('flac')) return 'flac';
  if (blobType?.includes('wav')) return 'wav';
  if (blobType?.includes('ogg')) return 'ogg';
  return 'mp3';
}

async function triggerBlobDownload(blob: Blob, filename: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

/** Download song audio as original or ffmpeg-converted format. */
export async function downloadSongAudio(opts: {
  audioUrl?: string | null;
  title?: string | null;
  songId?: string | null;
  format: DownloadFormat;
  token?: string | null;
}) {
  const title = (opts.title || 'song').replace(/[<>:"/\\|?*]/g, '_');
  const format = opts.format;

  if (format === 'original') {
    if (!opts.audioUrl) throw new Error('No audio URL');
    const response = await fetch(opts.audioUrl);
    const blob = await response.blob();
    const ext = extFromAudioUrl(opts.audioUrl, blob.type);
    await triggerBlobDownload(blob, `${title}.${ext}`);
    return;
  }

  // Prefer song export endpoint when we have an id
  if (opts.songId) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const response = await fetch(`/api/songs/${opts.songId}/download?format=${format}`, { headers });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Download failed (${response.status})`);
    }
    const blob = await response.blob();
    await triggerBlobDownload(blob, `${title}.${format}`);
    return;
  }

  if (!opts.audioUrl) throw new Error('No audio URL');
  const src = encodeURIComponent(opts.audioUrl);
  const response = await fetch(`/api/audio/export?src=${src}&format=${format}&title=${encodeURIComponent(title)}`);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Export failed (${response.status})`);
  }
  const blob = await response.blob();
  await triggerBlobDownload(blob, `${title}.${format}`);
}
