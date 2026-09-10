/** Phoenix localStorage helpers: prefer new keys, migrate legacy ace-/acestep_* once. */
export function lsGet(primary: string, legacy?: string): string | null {
  try {
    const cur = localStorage.getItem(primary);
    if (cur != null) return cur;
    if (!legacy) return null;
    const old = localStorage.getItem(legacy);
    if (old == null) return null;
    localStorage.setItem(primary, old);
    localStorage.removeItem(legacy);
    return old;
  } catch {
    return null;
  }
}

export function lsSet(primary: string, value: string, legacy?: string): void {
  try {
    localStorage.setItem(primary, value);
    if (legacy) localStorage.removeItem(legacy);
  } catch {
    /* ignore quota / private mode */
  }
}

export function lsRemove(primary: string, legacy?: string): void {
  try {
    localStorage.removeItem(primary);
    if (legacy) localStorage.removeItem(legacy);
  } catch {
    /* ignore */
  }
}

/** Canonical Phoenix keys + legacy ace-step names */
export const storageKeys = {
  token: { primary: "phoenix_token", legacy: "acestep_token" },
  user: { primary: "phoenix_user", legacy: "acestep_user" },
  model: { primary: "phoenix-model", legacy: "ace-model" },
  lmModel: { primary: "phoenix-lmModel", legacy: "ace-lmModel" },
  batchSize: { primary: "phoenix-batchSize", legacy: "ace-batchSize" },
  bulkCount: { primary: "phoenix-bulkCount", legacy: "ace-bulkCount" },
  lyricsHeight: { primary: "phoenix_lyrics_height", legacy: "acestep_lyrics_height" },
  styleHeight: { primary: "phoenix_style_height", legacy: "ace_style_height" },
  titleVersion: { primary: "phoenix_title_version", legacy: "ace_title_version" },
  dismissedNews: { primary: "phoenix-dismissed-news", legacy: "ace-dismissed-news" },
  createSettings: { primary: "phoenix-create-settings-v3c", legacy: "ace-create-settings-v3c" },
} as const;
