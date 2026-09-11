import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getGradioClient } from './gradio-client.js';
import { config } from '../config/index.js';

/** Shared LoRA tracker (kept in sync by routes/lora.ts). */
export const loraState = {
  loaded: false,
  active: false,
  scale: 1.0,
  path: '',
};

export function getLoraState() {
  return { ...loraState };
}

export function setLoraState(next: Partial<typeof loraState>): void {
  Object.assign(loraState, next);
}

function engineDir(): string {
  const envPath = process.env.PHOENIX_ENGINE_PATH || process.env.ACESTEP_PATH || config.phoenixEngine.path;
  if (envPath) return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '../../../Phoenix-Engine');
}

export function bootDitLooksTurbo(): boolean {
  try {
    const statusPath = path.join(engineDir(), 'phoenix-engine-status.json');
    if (!existsSync(statusPath)) return false;
    const st = JSON.parse(readFileSync(statusPath, 'utf8')) as { config_path?: string; is_turbo?: boolean };
    if (st.is_turbo === true) return true;
    return !!st.config_path && /turbo/i.test(String(st.config_path));
  } catch {
    return false;
  }
}

/**
 * Turbo DiT must never keep an SFT LoRA loaded. Unload + disable use_lora.
 */
export async function ensureLoraOffForTurbo(reason: string): Promise<void> {
  try {
    const client = await getGradioClient();
    if (loraState.active || loraState.loaded) {
      try {
        await client.predict('/set_use_lora', [false]);
      } catch (e) {
        console.warn('[LoRA] set_use_lora(false) during turbo guard:', e);
      }
      try {
        await client.predict('/unload_lora', []);
      } catch (e) {
        console.warn('[LoRA] unload_lora during turbo guard:', e);
      }
      loraState.loaded = false;
      loraState.active = false;
      loraState.scale = 1.0;
      loraState.path = '';
      console.log(`[LoRA] cleared for Turbo (${reason})`);
    } else {
      try {
        await client.predict('/set_use_lora', [false]);
      } catch { /* ignore */ }
      console.log(`[LoRA] turbo guard ensured use_lora=false (${reason})`);
    }
  } catch (e) {
    console.warn('[LoRA] ensureLoraOffForTurbo failed:', e);
  }
}
