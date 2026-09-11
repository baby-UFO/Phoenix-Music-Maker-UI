import dotenv from 'dotenv';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // SQLite database (phoenix.db preferred; legacy acestep.db still used if present)
  database: {
    path: process.env.DATABASE_PATH || (existsSync(path.join(__dirname, '../../data/phoenix.db'))
      ? path.join(__dirname, '../../data/phoenix.db')
      : existsSync(path.join(__dirname, '../../data/acestep.db'))
        ? path.join(__dirname, '../../data/acestep.db')
        : path.join(__dirname, '../../data/phoenix.db')),
  },

  // Phoenix Engine API (local Gradio). ACESTEP_* kept as legacy fallbacks.
  phoenixEngine: {
    apiUrl: process.env.PHOENIX_ENGINE_API_URL || process.env.ACESTEP_API_URL || 'http://localhost:8001',
    path: process.env.PHOENIX_ENGINE_PATH || process.env.ACESTEP_PATH || undefined,
  },

  // Pexels (optional - for video backgrounds)
  pexels: {
    apiKey: process.env.PEXELS_API_KEY || '',
  },

  // Frontend URL
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  // Storage (local only)
  storage: {
    provider: 'local' as const,
    audioDir: process.env.AUDIO_DIR || path.join(__dirname, '../../public/audio'),
  },

  // Training datasets (inside Phoenix Engine install so Gradio can access them)
  datasets: {
    dir: process.env.DATASETS_DIR || path.join(__dirname, '../../../Phoenix-Engine/datasets'),
    uploadsDir: process.env.DATASETS_UPLOADS_DIR || path.join(__dirname, '../../../Phoenix-Engine/datasets/uploads'),
  },

  // Simplified JWT (for local session, not critical security)
  jwt: {
    secret: process.env.JWT_SECRET || 'phoenix-music-maker-ui-local-secret',
    expiresIn: '365d', // Long-lived for local app
  },
};
