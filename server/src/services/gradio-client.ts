import { Client } from "@gradio/client";
import { config } from '../config/index.js';

let clientInstance: Client | null = null;
let connectionPromise: Promise<Client> | null = null;
/** Client currently mid-predict (may differ from cached singleton). */
let inFlightClient: Client | null = null;

type GradioClientExtras = Client & {
  closed?: boolean;
  abort_controller?: AbortController;
  stream_instance?: { close?: () => void };
};

/** Abort streams + close so Gradio frees the slot (ESTABLISHED sockets). */
export function hardClose(c: Client | null): void {
  if (!c) return;
  const x = c as GradioClientExtras;
  try { x.abort_controller?.abort(); } catch { /* ignore */ }
  try { x.stream_instance?.close?.(); } catch { /* ignore */ }
  try { c.close(); } catch (e) { console.warn('[Gradio] hardClose', e); }
}

/** Register the client about to call predict (in-flight socket tracking). */
export function setInFlightGradioClient(c: Client | null): void {
  inFlightClient = c;
}

/**
 * Hard-close cached + in-flight clients. Use on cancel even if job missing.
 */
export function forceCloseGradioSockets(): void {
  const a = clientInstance;
  const b = inFlightClient;
  clientInstance = null;
  connectionPromise = null;
  inFlightClient = null;
  hardClose(a);
  if (b && b !== a) hardClose(b);
}

/**
 * Get a lazy-initialized Gradio client connected to the Phoenix Engine Gradio app.
 * Caches the connection for reuse across requests.
 */
export async function getGradioClient(): Promise<Client> {
  if (clientInstance) {
    const closed = (clientInstance as GradioClientExtras).closed;
    if (closed === true) {
      clientInstance = null;
    } else {
      return clientInstance;
    }
  }
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    try {
      const client = await Client.connect(config.phoenixEngine.apiUrl, {
        events: ["data", "status"],
      });
      clientInstance = client;
      console.log(`[Gradio] Connected to ${config.phoenixEngine.apiUrl}`);
      return client;
    } catch (error) {
      console.error(`[Gradio] Failed to connect to ${config.phoenixEngine.apiUrl}:`, error);
      throw error;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

/**
 * Reset the cached Gradio client, forcing a new connection on next use.
 * MUST hard-close cached + in-flight so hung predicts abort and Gradio frees the slot.
 */
export function resetGradioClient(): void {
  forceCloseGradioSockets();
  console.log('[Gradio] client closed on reset');
}

/**
 * Check if the Gradio app is reachable.
 * Tries multiple well-known endpoints to handle version differences.
 */
export async function isGradioAvailable(): Promise<boolean> {
  const baseUrl = config.phoenixEngine.apiUrl;
  const candidates = [
    `${baseUrl}/gradio_api/info`,
    `${baseUrl}/info`,
    `${baseUrl}/`,
  ];

  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok || response.status < 500) return true;
    } catch {
      // Try next candidate
    }
  }
  return false;
}
