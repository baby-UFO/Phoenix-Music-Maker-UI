import { Client } from "@gradio/client";
import { config } from '../config/index.js';

let clientInstance: Client | null = null;
let connectionPromise: Promise<Client> | null = null;

/**
 * Get a lazy-initialized Gradio client connected to the Phoenix Engine Gradio app.
 * Caches the connection for reuse across requests.
 */
export async function getGradioClient(): Promise<Client> {
  if (clientInstance) {
    const closed = (clientInstance as { closed?: boolean }).closed;
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
 * MUST call Client.close() so hung predicts abort and Gradio frees the slot.
 */
export function resetGradioClient(): void {
  const prev = clientInstance;
  clientInstance = null;
  connectionPromise = null;
  if (prev) {
    try {
      prev.close();
      console.log('[Gradio] client closed on reset');
    } catch (e) {
      console.warn('[Gradio] close() on reset failed:', e);
    }
  }
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
