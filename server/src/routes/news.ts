import { Router, Request, Response } from 'express';
import { getGitHubNews } from '../services/githubNews.js';

const router = Router();

// GET /api/news — daily GitHub commit digests (newest first)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const items = await getGitHubNews();
    res.json({ items });
  } catch (error) {
    console.error('[news] Failed to load GitHub news:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Failed to load news', items: [] });
  }
});

export default router;