/**
 * GitHub-backed news digest for Phoenix Music Maker UI.
 * Groups commits by Pacific/Honolulu calendar day and summarizes them.
 * Never logs or returns tokens.
 */

export interface NewsItem {
  id: string;
  date: string;
  title: string;
  body: string;
  tags: string[];
}

interface GhCommit {
  sha: string;
  commit: {
    message: string;
    author: { date: string; name?: string } | null;
    committer: { date: string; name?: string } | null;
  };
}

const REPO = 'baby-UFO/Phoenix-Music-Maker-UI';
const BRANCHES = ['', 'babyufo/local-fixes-sep10'] as const; // '' = default branch
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TZ = 'Pacific/Honolulu';

let cache: { items: NewsItem[]; fetchedAt: number } | null = null;

function getToken(): string | undefined {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined;
}

function hawaiiDayKey(iso: string): string {
  // en-CA yields YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function formatDisplayDate(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const approx = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(approx);
}

function shortMonthDay(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const approx = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
  }).format(approx);
}

/** Strip conventional-commit prefix and clean subject. */
function cleanSubject(raw: string): string {
  let s = raw.split('\n')[0].trim();
  if (/^Merge (pull request|branch|remote-tracking)/i.test(s)) return '';
  s = s.replace(/^(feat|fix|style|docs|chore|refactor|perf|test|build|ci|revert)(\([^)]*\))?\s*:\s*/i, '');
  if (s.length > 0) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.trim();
}

function inferTag(message: string): string | null {
  const head = message.split('\n')[0].toLowerCase();
  if (/^feat(\(|:)/.test(head) || /\bfeature\b/.test(head)) return 'feature';
  if (/^fix(\(|:)/.test(head) || /\bbug\b/.test(head)) return 'bugfix';
  if (/^style(\(|:)/.test(head) || /\bui\b|\blayout\b|\btheme\b/.test(head)) return 'style';
  if (/^docs(\(|:)/.test(head)) return 'docs';
  if (/^refactor(\(|:)/.test(head)) return 'refactor';
  if (/^chore(\(|:)/.test(head)) return 'chore';
  if (/^perf(\(|:)/.test(head)) return 'perf';
  if (/\btrain(ing)?\b|\blora\b/.test(head)) return 'training';
  if (/\bbackend\b|\bapi\b|\bserver\b/.test(head)) return 'backend';
  return null;
}

function nearDuplicate(a: string, b: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return true;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

async function fetchCommitsForSha(sha?: string): Promise<GhCommit[]> {
  const url = new URL(`https://api.github.com/repos/${REPO}/commits`);
  url.searchParams.set('per_page', '100');
  if (sha) url.searchParams.set('sha', sha);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Phoenix-Music-Maker-UI-News',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub commits ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as GhCommit[];
}

async function fetchAllCommits(): Promise<GhCommit[]> {
  const bySha = new Map<string, GhCommit>();
  for (const branch of BRANCHES) {
    try {
      const list = await fetchCommitsForSha(branch || undefined);
      for (const c of list) {
        if (!bySha.has(c.sha)) bySha.set(c.sha, c);
      }
    } catch (err) {
      console.error('[githubNews] fetch branch failed:', branch || 'default', err instanceof Error ? err.message : err);
    }
  }
  return [...bySha.values()];
}

function summarizeDay(dayKey: string, commits: GhCommit[]): NewsItem {
  const sorted = [...commits].sort((a, b) => {
    const da = a.commit.author?.date || a.commit.committer?.date || '';
    const db = b.commit.author?.date || b.commit.committer?.date || '';
    return db.localeCompare(da);
  });

  const subjects: string[] = [];
  const tags = new Set<string>();

  for (const c of sorted) {
    const msg = c.commit.message || '';
    const cleaned = cleanSubject(msg);
    if (!cleaned) continue;
    if (subjects.some((s) => nearDuplicate(s, cleaned))) continue;
    subjects.push(cleaned);
    const tag = inferTag(msg);
    if (tag) tags.add(tag);
  }

  if (subjects.length === 0) {
    subjects.push('Repository updates');
  }

  const displayDate = formatDisplayDate(dayKey);
  let title: string;
  if (subjects.length === 1) {
    title = subjects[0];
  } else {
    const theme = tags.has('feature')
      ? 'Features and fixes'
      : tags.has('bugfix')
        ? 'Fixes and polish'
        : tags.has('style')
          ? 'UI polish'
          : `${subjects.length} updates`;
    title = `${shortMonthDay(dayKey)} — ${theme}`;
  }

  let body: string;
  if (subjects.length === 1) {
    body = subjects[0] + (subjects[0].endsWith('.') ? '' : '.');
  } else if (subjects.length <= 5) {
    body = subjects.map((s) => `• ${s}`).join('\n');
  } else {
    const head = subjects.slice(0, 4).map((s) => `• ${s}`);
    head.push(`• …and ${subjects.length - 4} more`);
    body = head.join('\n');
  }

  return {
    id: `gh-${dayKey}`,
    date: displayDate,
    title,
    body,
    tags: [...tags].slice(0, 4),
  };
}

export async function getGitHubNews(options?: { force?: boolean }): Promise<NewsItem[]> {
  const now = Date.now();
  if (!options?.force && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.items;
  }

  const commits = await fetchAllCommits();
  const byDay = new Map<string, GhCommit[]>();

  for (const c of commits) {
    const iso = c.commit.author?.date || c.commit.committer?.date;
    if (!iso) continue;
    const day = hawaiiDayKey(iso);
    const list = byDay.get(day) || [];
    list.push(c);
    byDay.set(day, list);
  }

  const items = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => summarizeDay(day, list));

  cache = { items, fetchedAt: now };
  return items;
}