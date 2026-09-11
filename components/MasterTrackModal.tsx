import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Sliders, Download, Loader2, Disc3, Gauge, Waves, Info, Sparkles
} from 'lucide-react';
import { Song } from '../types';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';
import { AlbumCover } from './AlbumCover';

export type MasterPresetId = 'streaming' | 'club' | 'soft';
export type MasterFormat = 'wav' | 'mp3' | 'flac' | 'ogg' | 'aac';

interface MasterTrackModalProps {
  isOpen: boolean;
  song: Song | null;
  onClose: () => void;
}

interface MasterMeters {
  input_i?: string;
  input_tp?: string;
  input_lra?: string;
  output_i?: string;
  output_tp?: string;
  output_lra?: string;
  target_offset?: string;
  [key: string]: string | undefined;
}

interface MasterResponse {
  success: boolean;
  audioUrl?: string | null;
  filename?: string;
  format?: string;
  meters?: MasterMeters | null;
  preset?: { id: string; label: string; I: number; TP: number; LRA: number; description: string };
  error?: string;
}

const PRESETS: {
  id: MasterPresetId;
  label: string;
  detail: string;
}[] = [
  { id: 'streaming', label: 'Streaming', detail: '−14 LUFS / −1 dBTP' },
  { id: 'club', label: 'Club', detail: '−9.5 LUFS / −1 dBTP' },
  { id: 'soft', label: 'Soft', detail: '−16 LUFS / −1.5 dBTP' },
];

const FORMATS: MasterFormat[] = ['wav', 'mp3', 'flac', 'ogg', 'aac'];

function KnobRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block space-y-1">
      <div className="flex justify-between text-xs text-zinc-400">
        <span>{label}</span>
        <span className="font-mono text-zinc-300">
          {value}
          {unit || ''}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-orange-500 disabled:opacity-40"
      />
    </label>
  );
}

export const MasterTrackModal: React.FC<MasterTrackModalProps> = ({ isOpen, song, onClose }) => {
  const { token } = useAuth();
  const { t } = useI18n();

  const [preset, setPreset] = useState<MasterPresetId>('streaming');
  const [format, setFormat] = useState<MasterFormat>('wav');
  const [bassDb, setBassDb] = useState(0.5);
  const [midDb, setMidDb] = useState(0);
  const [trebleDb, setTrebleDb] = useState(1.0);
  const [compThreshold, setCompThreshold] = useState(-18);
  const [compRatio, setCompRatio] = useState(2.5);
  const [stereoWidth, setStereoWidth] = useState(1.15);
  const [limitLevel, setLimitLevel] = useState(0.95);

  // Optional reference match (Matchering sidecar) — off by default; UI only until sidecar lands
  const [refMatchEnabled, setRefMatchEnabled] = useState(false);
  const [refFile, setRefFile] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MasterResponse | null>(null);
  const [status, setStatus] = useState<string>('');

  // Web Audio A/B preview (feature C — lightweight live graph)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const [previewBuf, setPreviewBuf] = useState<AudioBuffer | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [abMode, setAbMode] = useState<'A' | 'B'>('A'); // A=original, B=processed preview approx
  const [previewLoading, setPreviewLoading] = useState(false);
  const [matcheringStatus, setMatcheringStatus] = useState<{ available: boolean; backend: string; detail: string } | null>(null);
  const [qcMeters, setQcMeters] = useState<MasterMeters | null>(null);
  const [qcBusy, setQcBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [isOpen, busy, onClose]);

  // Reset when song changes / opens
  useEffect(() => {
    if (!isOpen || !song) return;
    setError(null);
    setResult(null);
    setStatus('');
    setRefMatchEnabled(false);
    setRefFile(null);
    setAbMode('A');
    stopPreview();
    setPreviewBuf(null);
  }, [isOpen, song?.id]);

  const stopPreview = useCallback(() => {
    try {
      sourceRef.current?.stop();
    } catch { /* ignore */ }
    sourceRef.current = null;
    setPreviewPlaying(false);
  }, []);

  useEffect(() => () => {
    stopPreview();
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, [stopPreview]);

  const loadPreviewBuffer = useCallback(async () => {
    if (!song?.audioUrl) return;
    setPreviewLoading(true);
    try {
      const ctx = audioCtxRef.current || new AudioContext();
      audioCtxRef.current = ctx;
      const res = await fetch(song.audioUrl);
      const arr = await res.arrayBuffer();
      const buf = await ctx.decodeAudioData(arr.slice(0));
      setPreviewBuf(buf);
    } catch (e) {
      console.warn('Preview load failed', e);
    } finally {
      setPreviewLoading(false);
    }
  }, [song?.audioUrl]);

  const playAb = useCallback(async (mode: 'A' | 'B') => {
    if (!previewBuf) {
      await loadPreviewBuffer();
    }
    const buf = previewBuf;
    const ctx = audioCtxRef.current || new AudioContext();
    audioCtxRef.current = ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    stopPreview();
    setAbMode(mode);

    // Need buffer — if still null after load, bail
    let useBuf = buf;
    if (!useBuf) {
      try {
        if (!song?.audioUrl) return;
        const res = await fetch(song.audioUrl);
        const arr = await res.arrayBuffer();
        useBuf = await ctx.decodeAudioData(arr.slice(0));
        setPreviewBuf(useBuf);
      } catch {
        return;
      }
    }

    const src = ctx.createBufferSource();
    src.buffer = useBuf;

    if (mode === 'A') {
      src.connect(ctx.destination);
    } else {
      // Approximate live B graph (EQ/comp/stereo/limit) — not identical to ffmpeg render
      const bass = ctx.createBiquadFilter();
      bass.type = 'lowshelf';
      bass.frequency.value = 100;
      bass.gain.value = bassDb;

      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking';
      mid.frequency.value = 1000;
      mid.Q.value = 1;
      mid.gain.value = midDb;

      const treble = ctx.createBiquadFilter();
      treble.type = 'highshelf';
      treble.frequency.value = 8000;
      treble.gain.value = trebleDb;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = compThreshold;
      comp.ratio.value = compRatio;
      comp.attack.value = 0.015;
      comp.release.value = 0.15;

      const gain = ctx.createGain();
      // crude stereo-width stand-in via makeup
      gain.gain.value = Math.min(1.2, 0.85 + stereoWidth * 0.15);

      src.connect(bass);
      bass.connect(mid);
      mid.connect(treble);
      treble.connect(comp);
      comp.connect(gain);
      gain.connect(ctx.destination);
    }

    src.onended = () => setPreviewPlaying(false);
    sourceRef.current = src;
    src.start(0);
    setPreviewPlaying(true);
  }, [
    previewBuf, loadPreviewBuffer, stopPreview, song?.audioUrl,
    bassDb, midDb, trebleDb, compThreshold, compRatio, stereoWidth,
  ]);

  
  const probeMatcheringStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/songs/master/matchering-status');
      const data = await res.json();
      setMatcheringStatus(data);
    } catch {
      setMatcheringStatus({ available: false, backend: 'unavailable', detail: 'Could not reach Matchering status endpoint' });
    }
  }, []);

  useEffect(() => {
    if (refMatchEnabled) probeMatcheringStatus();
  }, [refMatchEnabled, probeMatcheringStatus]);

  const runLoudnessQc = useCallback(async () => {
    if (!song?.id) return;
    setQcBusy(true);
    setError(null);
    try {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`/api/songs/${song.id}/loudness`, { headers, credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Loudness QC failed');
      setQcMeters(data.meters || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Loudness QC failed');
    } finally {
      setQcBusy(false);
    }
  }, [song?.id, token]);

  /** OfflineAudioContext bounce for B preview (feature C) — processes full buffer offline. */
  const playOfflineB = useCallback(async () => {
    if (!song?.audioUrl) return;
    setPreviewLoading(true);
    try {
      const ctx = audioCtxRef.current || new AudioContext();
      audioCtxRef.current = ctx;
      let buf = previewBuf;
      if (!buf) {
        const res = await fetch(song.audioUrl);
        const arr = await res.arrayBuffer();
        buf = await ctx.decodeAudioData(arr.slice(0));
        setPreviewBuf(buf);
      }
      const offline = new OfflineAudioContext(buf.numberOfChannels, buf.length, buf.sampleRate);
      const src = offline.createBufferSource();
      src.buffer = buf;

      const bassF = offline.createBiquadFilter();
      bassF.type = 'lowshelf';
      bassF.frequency.value = 100;
      bassF.gain.value = bassDb;
      const midF = offline.createBiquadFilter();
      midF.type = 'peaking';
      midF.frequency.value = 1000;
      midF.Q.value = 1;
      midF.gain.value = midDb;
      const trebleF = offline.createBiquadFilter();
      trebleF.type = 'highshelf';
      trebleF.frequency.value = 8000;
      trebleF.gain.value = trebleDb;
      const comp = offline.createDynamicsCompressor();
      comp.threshold.value = compThreshold;
      comp.ratio.value = compRatio;
      comp.attack.value = 0.015;
      comp.release.value = 0.15;
      const gain = offline.createGain();
      gain.gain.value = Math.min(1.2, 0.85 + stereoWidth * 0.15);

      src.connect(bassF);
      bassF.connect(midF);
      midF.connect(trebleF);
      trebleF.connect(comp);
      comp.connect(gain);
      gain.connect(offline.destination);
      src.start(0);
      const rendered = await offline.startRendering();

      stopPreview();
      setAbMode('B');
      if (ctx.state === 'suspended') await ctx.resume();
      const play = ctx.createBufferSource();
      play.buffer = rendered;
      play.connect(ctx.destination);
      play.onended = () => setPreviewPlaying(false);
      sourceRef.current = play;
      play.start(0);
      setPreviewPlaying(true);
    } catch (e) {
      console.warn('Offline B preview failed', e);
      await playAb('B');
    } finally {
      setPreviewLoading(false);
    }
  }, [song?.audioUrl, previewBuf, bassDb, midDb, trebleDb, compThreshold, compRatio, stereoWidth, stopPreview, playAb]);
  const canRender = Boolean(song?.id && song?.audioUrl);

  const handleRender = async () => {
    if (!song?.id) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setStatus(t('masterRendering') || 'Rendering master with Phoenix Engine…');
    try {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const knobsPayload = {
        bassDb,
        midDb,
        trebleDb,
        compThreshold,
        compRatio,
        stereoWidth,
        limitLevel,
      };

      let body: BodyInit;
      // Reference match is optional / sidecar — never block core master
      if (refMatchEnabled && refFile) {
        const fd = new FormData();
        fd.append('preset', preset);
        fd.append('format', format);
        fd.append('knobs', JSON.stringify(knobsPayload));
        fd.append('referenceMatch', 'true');
        fd.append('reference', refFile);
        body = fd;
        // Let browser set multipart boundary — do not set Content-Type
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({
          preset,
          format,
          knobs: knobsPayload,
          referenceMatch: refMatchEnabled ? true : undefined,
        });
      }

      const res = await fetch(`/api/songs/${song.id}/master`, {
        method: 'POST',
        headers,
        body,
        credentials: 'include',
      });
      const data = (await res.json().catch(() => ({}))) as MasterResponse;
      if (!res.ok) {
        throw new Error(data.error || `Master failed (${res.status})`);
      }
      setResult(data);
      setStatus(t('masterDone') || 'Master ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Master failed');
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    if (!result?.audioUrl && !result?.filename) return;
    try {
      const url = result.audioUrl;
      if (!url) {
        setError('Master file URL missing');
        return;
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch mastered file');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = result.filename || `${(song?.title || 'song').replace(/[<>:"/\\|?*]/g, '_')}_master.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    }
  };

  const metersLine = useMemo(() => {
    const m = result?.meters;
    if (!m) return null;
    const i = m.output_i || m.input_i;
    const tp = m.output_tp || m.input_tp;
    const lra = m.output_lra || m.input_lra;
    return { i, tp, lra };
  }, [result]);

  if (!isOpen || !song) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-white/10 w-full max-w-2xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-zinc-200 dark:border-white/5 sticky top-0 bg-white/95 dark:bg-zinc-900/95 backdrop-blur z-10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-rose-600 flex items-center justify-center shadow-lg">
              <Sliders size={18} className="text-white" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-zinc-900 dark:text-white truncate">
                {t('masterThisTrack') || 'Master this track'}
              </h2>
              <p className="text-xs text-zinc-500 truncate">Phoenix Engine · FFmpeg loudnorm</p>
            </div>
          </div>
          <button
            onClick={() => { if (!busy) onClose(); }}
            className="p-2 hover:bg-zinc-100 dark:hover:bg-white/5 rounded-full transition-colors"
            disabled={busy}
          >
            <X size={18} className="text-zinc-500" />
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* Song preload */}
          <div className="flex items-center gap-4 bg-zinc-50 dark:bg-zinc-800/50 rounded-xl p-3">
            <div className="w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 bg-zinc-700 relative">
              {song.coverUrl ? (
                <img src={song.coverUrl} alt="" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              ) : null}
              <AlbumCover seed={song.id || song.title} size="full" className={`w-full h-full ${song.coverUrl ? 'hidden' : ''}`} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-zinc-900 dark:text-white truncate">{song.title}</div>
              <div className="text-xs text-zinc-500 truncate">
                {song.audioUrl ? song.audioUrl.split('/').pop() : 'No audio'}
              </div>
              <div className="text-[10px] text-zinc-400 mt-0.5">
                Output uses <span className="font-mono text-orange-400">*_master.{format}</span> — source never overwritten
              </div>
            </div>
            <Disc3 size={18} className="text-orange-400/70 flex-shrink-0" />
          </div>

          {/* Presets */}
          <div>
            <div className="text-xs font-semibold tracking-wide text-zinc-500 mb-2 flex items-center gap-1.5">
              <Gauge size={12} /> PRESET
            </div>
            <div className="grid grid-cols-3 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={busy}
                  onClick={() => setPreset(p.id)}
                  className={`rounded-xl border px-3 py-3 text-left transition-all ${
                    preset === p.id
                      ? 'border-orange-500 bg-orange-500/10 text-white'
                      : 'border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-300 hover:border-orange-500/40'
                  }`}
                >
                  <div className="text-sm font-semibold">{p.label}</div>
                  <div className="text-[10px] opacity-70 mt-0.5">{p.detail}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Knobs */}
          <div>
            <div className="text-xs font-semibold tracking-wide text-zinc-500 mb-2 flex items-center gap-1.5">
              <Waves size={12} /> TONE & DYNAMICS
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-zinc-50 dark:bg-zinc-800/40 rounded-xl p-4">
              <KnobRow label="Bass" value={bassDb} min={-12} max={12} step={0.5} unit=" dB" onChange={setBassDb} disabled={busy} />
              <KnobRow label="Mid" value={midDb} min={-12} max={12} step={0.5} unit=" dB" onChange={setMidDb} disabled={busy} />
              <KnobRow label="Treble" value={trebleDb} min={-12} max={12} step={0.5} unit=" dB" onChange={setTrebleDb} disabled={busy} />
              <KnobRow label="Comp threshold" value={compThreshold} min={-40} max={0} step={1} unit=" dB" onChange={setCompThreshold} disabled={busy} />
              <KnobRow label="Comp ratio" value={compRatio} min={1} max={10} step={0.1} onChange={setCompRatio} disabled={busy} />
              <KnobRow label="Stereo width" value={stereoWidth} min={0} max={2} step={0.05} onChange={setStereoWidth} disabled={busy} />
              <KnobRow label="Limiter" value={limitLevel} min={0.5} max={1} step={0.01} onChange={setLimitLevel} disabled={busy} />
            </div>
          </div>

          {/* A/B preview */}
          <div>
            <div className="text-xs font-semibold tracking-wide text-zinc-500 mb-2">A/B PREVIEW (Web Audio)</div>
            <div className="flex flex-wrap gap-2 items-center mb-2">
              <button
                type="button"
                disabled={!canRender || qcBusy}
                onClick={runLoudnessQc}
                className="px-3 py-1.5 rounded-lg text-sm border border-zinc-300 dark:border-white/10 text-zinc-700 dark:text-zinc-300"
              >
                {qcBusy ? 'Measuring…' : 'Analyze loudness (QC)'}
              </button>
              {qcMeters && (
                <span className="text-[11px] font-mono text-zinc-400">
                  I {qcMeters.input_i ?? '—'} · TP {qcMeters.input_tp ?? '—'} · LRA {qcMeters.input_lra ?? '—'}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <button
                type="button"
                disabled={!canRender || previewLoading}
                onClick={() => playAb('A')}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  abMode === 'A' && previewPlaying
                    ? 'border-orange-500 bg-orange-500/20 text-white'
                    : 'border-zinc-300 dark:border-white/10 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                A · Original
              </button>
              <button
                type="button"
                disabled={!canRender || previewLoading}
                onClick={() => playOfflineB()}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  abMode === 'B' && previewPlaying
                    ? 'border-orange-500 bg-orange-500/20 text-white'
                    : 'border-zinc-300 dark:border-white/10 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                B · Preview EQ/Comp
              </button>
              {previewPlaying && (
                <button type="button" onClick={stopPreview} className="text-xs text-zinc-400 underline">
                  Stop
                </button>
              )}
              {previewLoading && <Loader2 size={14} className="animate-spin text-zinc-400" />}
              <span className="text-[10px] text-zinc-500">Live approx — final render uses FFmpeg</span>
            </div>
          </div>

          {/* Format */}
          <div>
            <div className="text-xs font-semibold tracking-wide text-zinc-500 mb-2">EXPORT FORMAT</div>
            <div className="flex flex-wrap gap-2">
              {FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  disabled={busy}
                  onClick={() => setFormat(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono uppercase border ${
                    format === f
                      ? 'border-orange-500 bg-orange-500/10 text-orange-300'
                      : 'border-zinc-300 dark:border-white/10 text-zinc-600 dark:text-zinc-400'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Optional Matchering */}
          <div className="rounded-xl border border-dashed border-zinc-300 dark:border-white/10 p-4 space-y-2">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1 accent-orange-500"
                checked={refMatchEnabled}
                disabled={busy}
                onChange={(e) => setRefMatchEnabled(e.target.checked)}
              />
              <div>
                <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
                  <Sparkles size={14} className="text-orange-400" />
                  {t('referenceMatchOptional') || 'Reference match (optional)'}
                </div>
                <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                  Uses an isolated Matchering sidecar (GPLv3) when available — never bundled in Phoenix Music Maker core.
                  Off by default. Core master remains FFmpeg LGPL.
                </p>
              </div>
            </label>
            {refMatchEnabled && (
              <div className="pl-7 space-y-2">
                <input
                  type="file"
                  accept="audio/*"
                  disabled={busy}
                  onChange={(e) => setRefFile(e.target.files?.[0] || null)}
                  className="block w-full text-xs text-zinc-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:text-zinc-200"
                />
                <div className="flex items-start gap-1.5 text-[10px] text-amber-500/90">
                  <Info size={12} className="mt-0.5 flex-shrink-0" />
                  <span>
                    Sidecar not required for mastering. If Matchering is missing, render still succeeds with FFmpeg only.{matcheringStatus ? ` Status: ${matcheringStatus.available ? 'available' : 'unavailable'} (${matcheringStatus.backend}) — ${matcheringStatus.detail}` : ''}
                    {refFile ? ` Reference: ${refFile.name}` : ''}
                  </span>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {status && !error && (
            <div className="text-sm text-zinc-300 flex items-center gap-2">
              {busy && <Loader2 size={14} className="animate-spin text-orange-400" />}
              {status}
            </div>
          )}

          {result?.success && (
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-4 space-y-2">
              <div className="text-sm font-semibold text-emerald-300">
                Master written: <span className="font-mono">{result.filename}</span>
              </div>
              {metersLine && (
                <div className="text-[11px] text-zinc-400 font-mono">
                  LUFS {metersLine.i ?? '—'} · TP {metersLine.tp ?? '—'} · LRA {metersLine.lra ?? '—'}
                </div>
              )}
              {result.audioUrl && (
                <audio controls src={result.audioUrl} className="w-full mt-1 h-8" />
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50"
            >
              {t('cancel') || 'Cancel'}
            </button>
            {result?.audioUrl && (
              <button
                type="button"
                onClick={handleDownload}
                className="px-4 py-2 text-sm rounded-lg border border-orange-500/40 text-orange-300 hover:bg-orange-500/10 flex items-center gap-2"
              >
                <Download size={14} />
                Download master
              </button>
            )}
            <button
              type="button"
              disabled={!canRender || busy}
              onClick={handleRender}
              className="px-5 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-orange-500 to-rose-600 text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-2 shadow-lg shadow-orange-500/20"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Sliders size={14} />}
              {busy ? (t('masterRendering') || 'Rendering…') : (t('renderMaster') || 'Render master')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
