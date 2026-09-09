export interface Env {
  LEADERBOARD_KV: KVNamespace;
  /** Fine-grained PAT, repo-scoped to lejeanbaptiste/scoreboard,
   * Contents: read+write only. Set via `wrangler secret put`, never
   * present in source or shipped to any client. */
  GITHUB_WRITE_TOKEN: string;
  /** Comma-separated GitHub user ids allowed to call /admin/*. A plain
   * var, not a secret: these are public account ids, and knowing one
   * grants nothing without that account's own GitHub token. */
  ADMIN_GITHUB_IDS: string;
}

const REPO_OWNER = 'lejeanbaptiste';
const REPO_NAME = 'scoreboard';
const SCORES_PATH = 'scores.json';
const AVATARS_DIR = 'avatars';

// Just enough to stop literal spam-clicking, not to slow down a genuine
// re-check after making progress.
const RATE_LIMIT_MS = 2 * 60 * 1000;
const MAX_STRING_LENGTH = 200;
const MAX_METRIC_VALUE = 10_000_000;
const REQUIRED_METRIC_KEYS = ['texts', 'tags', 'disambiguated', 'places', 'entities'] as const;
const METRIC_KEYS = [...REQUIRED_METRIC_KEYS, 'published'] as const;
// Generous for a small hover-preview thumbnail (a few hundred KB at most);
// well short of what would make a submission slow or bloat the repo.
const MAX_AVATAR_BASE64_LENGTH = 500_000;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
// GitHub account ids are decimal integers; anything else in an admin
// request is a typo or an attempt to steer the KV key / avatar path.
const ID_PATTERN = /^[0-9]{1,20}$/;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function isFiniteNonNegative(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_METRIC_VALUE
  );
}

function clampString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, MAX_STRING_LENGTH);
  return trimmed || fallback;
}

interface ValidatedSubmission {
  commission: string;
  metrics: Record<(typeof METRIC_KEYS)[number], number>;
  unlockedCount: number;
  totalAchievements: number;
}

/** Same validation contract as scripts/process-submission.mjs (the
 * Phase-1 GitHub-Issues path) - malformed/hostile input is rejected
 * outright, not partially trusted. */
function validateSubmission(raw: unknown): ValidatedSubmission | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const metrics = body.metrics;
  if (!metrics || typeof metrics !== 'object') return null;
  const metricsRecord = metrics as Record<string, unknown>;
  for (const key of REQUIRED_METRIC_KEYS) {
    if (!isFiniteNonNegative(metricsRecord[key])) return null;
  }
  if (metricsRecord.published !== undefined && !isFiniteNonNegative(metricsRecord.published)) {
    return null;
  }
  if (!isFiniteNonNegative(body.unlockedCount) || !isFiniteNonNegative(body.totalAchievements)) {
    return null;
  }
  return {
    commission: clampString(body.commission, 'Civil'),
    metrics: Object.fromEntries(
      METRIC_KEYS.map((key) => [
        key,
        key === 'published' ? (metricsRecord[key] ?? 0) : metricsRecord[key],
      ]),
    ) as ValidatedSubmission['metrics'],
    unlockedCount: body.unlockedCount as number,
    totalAchievements: body.totalAchievements as number,
  };
}

/** Decodes and sanity-checks an optional avatar payload. Returns null for
 * "no avatar sent" (fine, just skip uploading one) as well as for
 * anything malformed/oversized/not actually a PNG (also fine - a broken
 * avatar upload should never fail the underlying score submission). */
function validateAvatarBase64(raw: unknown): Uint8Array | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_AVATAR_BASE64_LENGTH) {
    return null;
  }
  try {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    if (!PNG_MAGIC.every((byte, i) => bytes[i] === byte)) return null;
    return bytes;
  } catch {
    return null;
  }
}

interface GitHubUser {
  id: number;
  login: string;
}

/** The only identity check here: ask GitHub who this token belongs to.
 * A client can claim anything in its request body except this - the
 * token itself has to actually be valid and GitHub has to vouch for the
 * account behind it. */
async function verifyGitHubUser(token: string): Promise<GitHubUser | null> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'ljb-leaderboard-worker',
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { id?: number; login?: string };
  if (typeof data.id !== 'number' || typeof data.login !== 'string') return null;
  return { id: data.id, login: data.login };
}

interface ScoreEntry {
  id: string;
  displayName: string;
  commission: string;
  metrics: ValidatedSubmission['metrics'];
  unlockedCount: number;
  totalAchievements: number;
  updatedAt: string;
}

async function loadAllEntries(kv: KVNamespace): Promise<ScoreEntry[]> {
  const entries: ScoreEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'score:', cursor });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      if (raw) entries.push(JSON.parse(raw) as ScoreEntry);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return entries;
}

/** Writes (or overwrites) a file in the public repo via GitHub's Contents
 * API - the only thing with write access to that repo is this Worker's
 * own secret, never a client. */
async function putGitHubFile(
  env: Env,
  path: string,
  base64Content: string,
  message: string,
): Promise<void> {
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;
  const headers = {
    authorization: `Bearer ${env.GITHUB_WRITE_TOKEN}`,
    'user-agent': 'ljb-leaderboard-worker',
    accept: 'application/vnd.github+json',
  };

  const existing = await fetch(apiUrl, { headers });
  const sha = existing.ok ? ((await existing.json()) as { sha?: string }).sha : undefined;

  const putResponse = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ message, content: base64Content, sha }),
  });
  if (!putResponse.ok) {
    throw new Error(
      `GitHub contents PUT failed for ${path}: ${putResponse.status} ${await putResponse.text()}`,
    );
  }
}

/** Removes a file from the public repo. A file that isn't there counts as
 * success - the caller wanted it gone, and it is. */
async function deleteGitHubFile(env: Env, path: string, message: string): Promise<void> {
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;
  const headers = {
    authorization: `Bearer ${env.GITHUB_WRITE_TOKEN}`,
    'user-agent': 'ljb-leaderboard-worker',
    accept: 'application/vnd.github+json',
  };

  const existing = await fetch(apiUrl, { headers });
  if (existing.status === 404) return;
  const sha = existing.ok ? ((await existing.json()) as { sha?: string }).sha : undefined;
  if (!sha) return;

  const deleteResponse = await fetch(apiUrl, {
    method: 'DELETE',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ message, sha }),
  });
  if (!deleteResponse.ok) {
    throw new Error(
      `GitHub contents DELETE failed for ${path}: ${deleteResponse.status} ${await deleteResponse.text()}`,
    );
  }
}

/** Lists a directory in the public repo, or [] if it doesn't exist. */
async function listGitHubDir(env: Env, path: string): Promise<string[]> {
  const response = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`,
    {
      headers: {
        authorization: `Bearer ${env.GITHUB_WRITE_TOKEN}`,
        'user-agent': 'ljb-leaderboard-worker',
        accept: 'application/vnd.github+json',
      },
    },
  );
  if (!response.ok) return [];
  const entries = (await response.json()) as unknown;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => (entry as { path?: unknown }).path)
    .filter((entryPath): entryPath is string => typeof entryPath === 'string');
}

async function publishScoresJson(env: Env, entries: ScoreEntry[]): Promise<void> {
  const content = `${JSON.stringify(entries, null, 2)}\n`;
  const base64Content = btoa(unescape(encodeURIComponent(content)));
  await putGitHubFile(
    env,
    SCORES_PATH,
    base64Content,
    `Update leaderboard (${entries.length} entries)`,
  );
}

/** Best-effort - a failed avatar upload should never fail the underlying
 * score submission, so callers just log and move on. */
async function publishAvatar(env: Env, id: string, base64Png: string): Promise<void> {
  await putGitHubFile(env, `${AVATARS_DIR}/${id}.png`, base64Png, `Update avatar for ${id}`);
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Request body must be JSON.' }, 400);
  }

  const token =
    typeof (body as Record<string, unknown>)?.token === 'string'
      ? (body as Record<string, string>).token
      : null;
  if (!token) return json({ error: 'Missing token.' }, 400);

  const submission = validateSubmission(body);
  if (!submission) return json({ error: 'Malformed submission payload.' }, 400);

  const user = await verifyGitHubUser(token);
  if (!user) return json({ error: 'Could not verify GitHub identity for this token.' }, 401);

  const id = String(user.id);
  const rateLimitKey = `ratelimit:${id}`;
  const lastSubmitted = await env.LEADERBOARD_KV.get(rateLimitKey);
  if (lastSubmitted) {
    const elapsed = Date.now() - Number(lastSubmitted);
    if (elapsed < RATE_LIMIT_MS) {
      const waitMinutes = Math.ceil((RATE_LIMIT_MS - elapsed) / 60000);
      return json(
        {
          error: `Submitted too recently - try again in about ${waitMinutes} minute(s).`,
        },
        429,
      );
    }
  }

  const now = new Date();
  const candidate: ScoreEntry = {
    id,
    displayName: user.login,
    commission: submission.commission,
    metrics: submission.metrics,
    unlockedCount: submission.unlockedCount,
    totalAchievements: submission.totalAchievements,
    updatedAt: now.toISOString(),
  };

  // Local progress is a high-water mark (it only ever increases), so a
  // legitimate resubmission should never rank lower than a previous one -
  // the only way that happens is a submission from a machine/project
  // that's genuinely behind. Keep whichever submission ranks higher
  // wholesale (not a field-by-field merge) so stats and commission stay
  // internally consistent with each other.
  const existingRaw = await env.LEADERBOARD_KV.get(`score:${id}`);
  const existing = existingRaw ? (JSON.parse(existingRaw) as ScoreEntry) : null;
  const isImprovement = !existing || candidate.unlockedCount >= existing.unlockedCount;
  const finalEntry = isImprovement ? candidate : existing;

  await env.LEADERBOARD_KV.put(`score:${id}`, JSON.stringify(finalEntry));
  await env.LEADERBOARD_KV.put(rateLimitKey, String(now.getTime()));

  const avatarBytes = validateAvatarBase64((body as Record<string, unknown>).avatarPngBase64);
  if (avatarBytes) {
    try {
      await publishAvatar(env, id, (body as Record<string, string>).avatarPngBase64);
    } catch {
      // Decorative - never fail the score submission over a portrait upload.
    }
  }

  const allEntries = await loadAllEntries(env.LEADERBOARD_KV);
  await publishScoresJson(env, allEntries);

  return json({
    ok: true,
    message: isImprovement
      ? `Added to the leaderboard as ${user.login}.`
      : `Your best score is already on the leaderboard as ${user.login} - this submission ranked lower, so it was not applied.`,
  });
}

function isAdmin(env: Env, id: string): boolean {
  return (env.ADMIN_GITHUB_IDS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(id);
}

/** Admin auth reuses the same identity guarantee as /submit: the caller
 * proves who they are with their own GitHub token and GitHub vouches for
 * it, then that account has to be on the allowlist. Deliberately not a
 * shared admin secret - one of those, once leaked, lets anyone wipe the
 * board, whereas a leaked GitHub token only ever speaks for an account
 * that isn't on the list. */
async function verifyAdmin(body: unknown, env: Env): Promise<GitHubUser | null> {
  const token =
    typeof (body as Record<string, unknown>)?.token === 'string'
      ? (body as Record<string, string>).token
      : null;
  if (!token) return null;
  const user = await verifyGitHubUser(token);
  if (!user || !isAdmin(env, String(user.id))) return null;
  return user;
}

/** Collects every key under a prefix before deleting any of them - KV
 * list results are a snapshot, so mutating mid-pagination can skip keys. */
async function listKeyNames(kv: KVNamespace, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const key of page.keys) names.push(key.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

/** Removes one player: their KV row, their rate-limit entry, their
 * portrait, and their line in the published scores.json. Every clear has
 * to go through here rather than being committed straight to
 * scores.json - the file is only ever a rendering of KV, so editing it
 * directly leaves the row in KV to be republished by the next unrelated
 * submission. */
async function handleAdminDelete(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Request body must be JSON.' }, 400);
  }

  const admin = await verifyAdmin(body, env);
  if (!admin) return json({ error: 'Not authorized.' }, 403);

  const targetId = (body as Record<string, unknown>).id;
  if (typeof targetId !== 'string' || !ID_PATTERN.test(targetId)) {
    return json({ error: 'Missing or malformed player id.' }, 400);
  }

  const removed = (await env.LEADERBOARD_KV.get(`score:${targetId}`)) !== null;
  await env.LEADERBOARD_KV.delete(`score:${targetId}`);
  await env.LEADERBOARD_KV.delete(`ratelimit:${targetId}`);

  // KV reads are eventually consistent, so a list taken right after the
  // delete can still hand back the row we just removed - filter it out
  // explicitly rather than republishing it by accident.
  const entries = (await loadAllEntries(env.LEADERBOARD_KV)).filter(
    (entry) => entry.id !== targetId,
  );
  await publishScoresJson(env, entries);

  try {
    await deleteGitHubFile(env, `${AVATARS_DIR}/${targetId}.png`, `Remove avatar for ${targetId}`);
  } catch {
    // Decorative - an orphaned portrait shouldn't report the removal as failed.
  }

  return json({
    ok: true,
    removed,
    remaining: entries.length,
    message: removed
      ? `Removed ${targetId} from the leaderboard.`
      : `No leaderboard entry for ${targetId} - nothing to remove.`,
  });
}

/** Empties the leaderboard: every KV row and rate-limit entry, every
 * portrait, and scores.json itself. */
async function handleAdminClear(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Request body must be JSON.' }, 400);
  }

  const admin = await verifyAdmin(body, env);
  if (!admin) return json({ error: 'Not authorized.' }, 403);

  const scoreKeys = await listKeyNames(env.LEADERBOARD_KV, 'score:');
  const rateLimitKeys = await listKeyNames(env.LEADERBOARD_KV, 'ratelimit:');
  for (const name of [...scoreKeys, ...rateLimitKeys]) {
    await env.LEADERBOARD_KV.delete(name);
  }

  await publishScoresJson(env, []);

  try {
    for (const path of await listGitHubDir(env, AVATARS_DIR)) {
      await deleteGitHubFile(env, path, 'Clear leaderboard avatars');
    }
  } catch {
    // Decorative - orphaned portraits shouldn't report the clear as failed.
  }

  return json({
    ok: true,
    removed: scoreKeys.length,
    message: `Cleared the leaderboard (${scoreKeys.length} entries).`,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const routes: Record<string, (request: Request, env: Env) => Promise<Response>> = {
      '/submit': handleSubmit,
      '/admin/delete': handleAdminDelete,
      '/admin/clear': handleAdminClear,
    };
    const handler = request.method === 'POST' ? routes[url.pathname] : undefined;
    if (handler) {
      try {
        return await handler(request, env);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : 'Internal error.' }, 500);
      }
    }
    return json({ error: 'Not found.' }, 404);
  },
};
