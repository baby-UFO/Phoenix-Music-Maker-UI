/**
 * Matchering sidecar probe — NEVER imports Matchering into PMM core.
 * Preferred: Docker sergree/matchering-web on 127.0.0.1:8360
 * Fallback: isolated CLI under E:\Phoenix-Tools\matchering-sidecar
 * GPLv3 stays quarantined outside Phoenix Music Maker / Phoenix Engine.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DOCKER_BASE = process.env.PMM_MATCHERING_URL || 'http://127.0.0.1:8360';
const TOOLS_DIR = process.env.PMM_MATCHERING_TOOLS || 'E:\\Phoenix-Tools\\matchering-sidecar';

export type MatcheringBackend = 'docker-http' | 'cli' | 'unavailable';

export interface MatcheringStatus {
  available: boolean;
  backend: MatcheringBackend;
  detail: string;
  license: string;
}

export async function probeMatchering(): Promise<MatcheringStatus> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(DOCKER_BASE + '/', { signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    if (res && (res.ok || res.status === 200 || res.status === 404 || res.status === 405)) {
      return {
        available: true,
        backend: 'docker-http',
        detail: `Reachable at ${DOCKER_BASE}`,
        license: 'GPLv3 (sidecar only — not part of Phoenix Music Maker core)',
      };
    }
  } catch { /* fall through */ }

  const py = path.join(TOOLS_DIR, 'venv', 'Scripts', 'python.exe');
  const bat = path.join(TOOLS_DIR, 'matchering-cli.bat');
  // Require isolated venv python so an empty bat stub is not "available"
  if (fs.existsSync(py)) {
    const detail = fs.existsSync(bat)
      ? `CLI+venv at ${bat}`
      : `venv python at ${py} (use: python -m matchering …)`;
    return {
      available: true,
      backend: 'cli',
      detail,
      license: 'GPLv3 (sidecar only — not part of Phoenix Music Maker core)',
    };
  }

  return {
    available: false,
    backend: 'unavailable',
    detail: `No Matchering sidecar. Start Docker (sergree/matchering-web on ${DOCKER_BASE}) or install CLI under ${TOOLS_DIR}. Core FFmpeg master still works.`,
    license: 'GPLv3 (sidecar only — not part of Phoenix Music Maker core)',
  };
}

/**
 * Optional reference match. Returns output WAV path or null if unavailable / failed.
 * Never throws into core master path — caller treats null as skip (FFmpeg only).
 */
export async function tryReferenceMatch(opts: {
  targetPath: string;
  referencePath: string;
}): Promise<{ outputPath: string; backend: MatcheringBackend } | null> {
  const status = await probeMatchering();
  if (!status.available) return null;

  const out = path.join(
    os.tmpdir(),
    `pmm-matchering-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
  );

  if (status.backend === 'cli') {
    const py = path.join(TOOLS_DIR, 'venv', 'Scripts', 'python.exe');
    const cliBat = path.join(TOOLS_DIR, 'matchering-cli.bat');
    const cmd = fs.existsSync(cliBat) ? cliBat : py;
    const fullArgs = fs.existsSync(cliBat)
      ? [opts.targetPath, opts.referencePath, out]
      : ['-m', 'matchering', opts.targetPath, opts.referencePath, out];

    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn(cmd, fullArgs, { windowsHide: true, cwd: TOOLS_DIR });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0 && fs.existsSync(out)));
    });
    if (!ok) return null;
    return { outputPath: out, backend: 'cli' };
  }

  try {
    const form = new FormData();
    const targetBuf = fs.readFileSync(opts.targetPath);
    const refBuf = fs.readFileSync(opts.referencePath);
    form.append('target', new Blob([targetBuf]), path.basename(opts.targetPath));
    form.append('reference', new Blob([refBuf]), path.basename(opts.referencePath));
    const res = await fetch(`${DOCKER_BASE}/process`, { method: 'POST', body: form as any });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    if (!ab.byteLength) return null;
    fs.writeFileSync(out, Buffer.from(ab));
    return { outputPath: out, backend: 'docker-http' };
  } catch {
    return null;
  }
}