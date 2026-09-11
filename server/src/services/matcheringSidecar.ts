/**
 * Matchering sidecar probe — NEVER imports Matchering into PMM core.
 * Preferred: Docker sergree/matchering-web on 127.0.0.1:8360
 * Fallback: isolated CLI under E:\Phoenix-Tools\matchering-sidecar (mg_cli.py)
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

const GPL_NOTE = 'GPLv3 (sidecar only — not part of Phoenix Music Maker core)';

function cliPython(): string {
  return path.join(TOOLS_DIR, 'venv', 'Scripts', 'python.exe');
}

function cliScript(): string {
  return path.join(TOOLS_DIR, 'mg_cli.py');
}

function cliBat(): string {
  return path.join(TOOLS_DIR, 'matchering-cli.bat');
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
        license: GPL_NOTE,
      };
    }
  } catch {
    /* fall through */
  }

  const py = cliPython();
  const mg = cliScript();
  const bat = cliBat();
  // Require isolated venv python so an empty bat stub is not "available"
  if (fs.existsSync(py) && (fs.existsSync(mg) || fs.existsSync(bat))) {
    const detail = fs.existsSync(mg)
      ? `CLI mg_cli.py + venv at ${TOOLS_DIR}`
      : `CLI+venv at ${bat}`;
    return {
      available: true,
      backend: 'cli',
      detail,
      license: GPL_NOTE,
    };
  }

  return {
    available: false,
    backend: 'unavailable',
    detail: `No Matchering sidecar. Start Docker (sergree/matchering-web on ${DOCKER_BASE}) or install CLI under ${TOOLS_DIR}. Core FFmpeg master still works.`,
    license: GPL_NOTE,
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
    const py = cliPython();
    const mg = cliScript();
    const bat = cliBat();

    let cmd: string;
    let args: string[];
    if (fs.existsSync(mg) && fs.existsSync(py)) {
      cmd = py;
      args = [mg, opts.targetPath, opts.referencePath, out];
    } else if (fs.existsSync(bat)) {
      cmd = bat;
      args = [opts.targetPath, opts.referencePath, out];
    } else {
      return null;
    }

    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn(cmd, args, { windowsHide: true, cwd: TOOLS_DIR });
      let stderr = '';
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => {
        if (code !== 0) {
          console.warn('[matcheringSidecar] CLI exit', code, stderr.slice(-400));
        }
        resolve(code === 0 && fs.existsSync(out));
      });
    });
    if (!ok) return null;
    return { outputPath: out, backend: 'cli' };
  }

  // docker-http: POST files to sidecar (no import matchering in PMM)
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