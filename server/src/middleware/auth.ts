import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { generateUUID } from '../db/sqlite.js';

export interface AuthenticatedUser {
  id: string;
  username: string;
  isAdmin?: boolean;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

const DEFAULT_USERNAME = process.env.PMM_DEFAULT_USERNAME || process.env.PHOENIX_DEFAULT_USERNAME || 'babyUFO';

/** Resolve-or-create the single local OSS user. Never leaves product APIs without an identity. */
export async function resolveLocalUser(): Promise<AuthenticatedUser> {
  const existing = await pool.query(
    'SELECT id, username, is_admin FROM users ORDER BY created_at ASC LIMIT 1'
  );
  if (existing.rows.length > 0) {
    const u = existing.rows[0];
    return { id: u.id, username: u.username, isAdmin: Boolean(u.is_admin) };
  }
  const userId = generateUUID();
  const username = String(DEFAULT_USERNAME).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'babyUFO';
  await pool.query(
    `INSERT INTO users (id, username, is_admin, created_at, updated_at)
     VALUES (?, ?, 1, datetime('now'), datetime('now'))`,
    [userId, username]
  );
  return { id: userId, username, isAdmin: true };
}

export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  const finishWithLocal = () => {
    resolveLocalUser()
      .then((user) => {
        req.user = user;
        next();
      })
      .catch((err) => {
        console.error('[Auth] resolveLocalUser failed:', err);
        res.status(500).json({ error: 'Local user resolve failed' });
      });
  };

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Local OSS: never 401 — inject default local user
    finishWithLocal();
    return;
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, config.jwt.secret) as AuthenticatedUser;
    req.user = decoded;
    next();
  } catch {
    // Invalid token: still fall back to local user (zero-auth)
    finishWithLocal();
  }
}

export function optionalAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, config.jwt.secret) as AuthenticatedUser;
      req.user = decoded;
      next();
      return;
    } catch {
      // fall through to local
    }
  }

  resolveLocalUser()
    .then((user) => {
      req.user = user;
      next();
    })
    .catch(() => next());
}

export async function adminMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Local OSS: treat default local user as admin-capable
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.substring(7), config.jwt.secret) as AuthenticatedUser;
        req.user = { ...decoded, isAdmin: true };
        next();
        return;
      } catch {
        /* fall through */
      }
    }
    const user = await resolveLocalUser();
    req.user = { ...user, isAdmin: true };
    next();
  } catch (err) {
    console.error('[Auth] adminMiddleware failed:', err);
    res.status(500).json({ error: 'Local admin resolve failed' });
  }
}
