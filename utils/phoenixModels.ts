/**
 * Phoenix model ID mapping.
 * UI / app-level IDs are phoenix-*; on-disk HF checkpoints and Gradio remain acestep-*.
 * Translate at the server/engine boundary with toEngineModelId before Gradio/python/boot.
 */

export const PHOENIX_DIT_MODELS = [
  'phoenix-v15-base',
  'phoenix-v15-sft',
  'phoenix-v15-turbo',
  'phoenix-v15-turbo-shift1',
  'phoenix-v15-turbo-shift3',
  'phoenix-v15-turbo-continuous',
] as const;

export const PHOENIX_LM_MODELS = [
  'phoenix-5Hz-lm-0.6B',
  'phoenix-5Hz-lm-1.7B',
  'phoenix-5Hz-lm-4B',
] as const;

export type PhoenixDitModelId = (typeof PHOENIX_DIT_MODELS)[number];
export type PhoenixLmModelId = (typeof PHOENIX_LM_MODELS)[number];

const PHOENIX_TO_ENGINE: Record<string, string> = {
  'phoenix-v15-base': 'acestep-v15-base',
  'phoenix-v15-sft': 'acestep-v15-sft',
  'phoenix-v15-turbo': 'acestep-v15-turbo',
  'phoenix-v15-turbo-shift1': 'acestep-v15-turbo-shift1',
  'phoenix-v15-turbo-shift3': 'acestep-v15-turbo-shift3',
  'phoenix-v15-turbo-continuous': 'acestep-v15-turbo-continuous',
  'phoenix-5Hz-lm-0.6B': 'acestep-5Hz-lm-0.6B',
  'phoenix-5Hz-lm-1.7B': 'acestep-5Hz-lm-1.7B',
  'phoenix-5Hz-lm-4B': 'acestep-5Hz-lm-4B',
};

const ENGINE_TO_PHOENIX: Record<string, string> = Object.fromEntries(
  Object.entries(PHOENIX_TO_ENGINE).map(([phoenix, engine]) => [engine, phoenix]),
);

const PHOENIX_LABELS: Record<string, string> = {
  'phoenix-v15-base': 'Phoenix V15 Base',
  'phoenix-v15-sft': 'Phoenix V15 SFT',
  'phoenix-v15-turbo': 'Phoenix V15 Turbo',
  'phoenix-v15-turbo-shift1': 'Phoenix V15 Turbo S1',
  'phoenix-v15-turbo-shift3': 'Phoenix V15 Turbo S3',
  'phoenix-v15-turbo-continuous': 'Phoenix V15 Turbo Continuous',
  'phoenix-5Hz-lm-0.6B': 'Phoenix 5Hz LM 0.6B',
  'phoenix-5Hz-lm-1.7B': 'Phoenix 5Hz LM 1.7B',
  'phoenix-5Hz-lm-4B': 'Phoenix 5Hz LM 4B',
};

/** Strip path / whitespace; return basename-ish id. */
function normalizeId(id: string | null | undefined): string {
  if (!id) return '';
  let s = String(id).trim().replace(/\\/g, '/');
  if (s.includes('/')) s = s.split('/').pop() || s;
  return s;
}

/**
 * Map any Phoenix or legacy acestep id (or path) to the engine/HF folder name (acestep-*).
 * Unknown ids that already look like acestep-* pass through; phoenix-* unknown suffixes
 * are rewritten via prefix replace.
 */
export function toEngineModelId(phoenixOrLegacy: string | null | undefined): string {
  const id = normalizeId(phoenixOrLegacy);
  if (!id) return id;
  if (PHOENIX_TO_ENGINE[id]) return PHOENIX_TO_ENGINE[id];
  if (ENGINE_TO_PHOENIX[id]) return id; // already engine id
  if (id.startsWith('phoenix-')) return id.replace(/^phoenix-/, 'acestep-');
  if (id.startsWith('acestep-')) return id;
  return id;
}

/**
 * Map any engine/legacy id to the Phoenix app-level id (phoenix-*).
 */
export function toPhoenixModelId(engineOrLegacy: string | null | undefined): string {
  const id = normalizeId(engineOrLegacy);
  if (!id) return id;
  if (ENGINE_TO_PHOENIX[id]) return ENGINE_TO_PHOENIX[id];
  if (PHOENIX_TO_ENGINE[id]) return id; // already phoenix
  if (id.startsWith('acestep-')) return id.replace(/^acestep-/, 'phoenix-');
  if (id.startsWith('phoenix-')) return id;
  return id;
}

/** Human-readable label for UI chrome. Accepts phoenix or acestep ids. */
export function getPhoenixModelLabel(id: string | null | undefined): string {
  if (!id) return 'Phoenix V15';
  const phoenix = toPhoenixModelId(id);
  if (PHOENIX_LABELS[phoenix]) return PHOENIX_LABELS[phoenix];
  // Fallback: prettify phoenix id
  if (phoenix.startsWith('phoenix-v15-')) {
    const rest = phoenix.slice('phoenix-v15-'.length);
    const pretty = rest
      .replace(/^turbo-shift1$/, 'Turbo S1')
      .replace(/^turbo-shift3$/, 'Turbo S3')
      .replace(/^turbo-continuous$/, 'Turbo Continuous')
      .replace(/^turbo$/, 'Turbo')
      .replace(/^base$/, 'Base')
      .replace(/^sft$/i, 'SFT');
    return `Phoenix V15 ${pretty}`;
  }
  if (phoenix.startsWith('phoenix-5Hz-lm-')) {
    return `Phoenix 5Hz LM ${phoenix.slice('phoenix-5Hz-lm-'.length)}`;
  }
  return phoenix || 'Phoenix V15';
}

/** Migrate a stored model id from acestep-* (or mixed) to phoenix-*. */
export function migrateToPhoenixModelId(id: string | null | undefined): string {
  return toPhoenixModelId(id);
}

export function isTurboModelId(id: string | null | undefined): boolean {
  const n = normalizeId(id).toLowerCase();
  return n.includes('turbo');
}

export function isPhoenixDitId(id: string | null | undefined): boolean {
  const p = toPhoenixModelId(id);
  return (PHOENIX_DIT_MODELS as readonly string[]).includes(p) || p.startsWith('phoenix-v15-');
}

export function isPhoenixLmId(id: string | null | undefined): boolean {
  const p = toPhoenixModelId(id);
  return (PHOENIX_LM_MODELS as readonly string[]).includes(p) || p.startsWith('phoenix-5Hz-lm-');
}
