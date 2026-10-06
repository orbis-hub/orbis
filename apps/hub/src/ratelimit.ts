/**
 * In-memory sliding-window counter for failed logins, keyed by ip + account name.
 * Only failures count; a successful login clears the key. Restarting the hub resets everything,
 * which is fine for a single-process home server.
 */
const WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 10;
const failures = new Map<string, number[]>();
let sweepAt = 0;

function prune(key: string, nowMs: number) {
  const list = failures.get(key);
  if (!list) return [];
  const kept = list.filter((t) => t > nowMs - WINDOW_MS);
  if (kept.length) failures.set(key, kept);
  else failures.delete(key);
  return kept;
}

function sweep(nowMs: number) {
  if (nowMs < sweepAt) return;
  sweepAt = nowMs + WINDOW_MS;
  for (const key of [...failures.keys()]) prune(key, nowMs);
}

/** `{ blocked: true, retryAfter }` (seconds) once MAX_FAILURES failures happened inside the window. */
export function loginThrottle(key: string, nowMs = Date.now()): { blocked: boolean; retryAfter: number; remaining: number } {
  sweep(nowMs);
  const list = prune(key, nowMs);
  if (list.length >= MAX_FAILURES) {
    const oldest = Math.min(...list);
    return { blocked: true, retryAfter: Math.max(1, Math.ceil((oldest + WINDOW_MS - nowMs) / 1000)), remaining: 0 };
  }
  return { blocked: false, retryAfter: 0, remaining: MAX_FAILURES - list.length };
}

export function recordLoginFailure(key: string, nowMs = Date.now()) {
  const list = prune(key, nowMs);
  list.push(nowMs);
  failures.set(key, list);
}

export function clearLoginFailures(key: string) {
  failures.delete(key);
}

/** test hook */
export function resetLoginThrottle() {
  failures.clear();
  sweepAt = 0;
}

export const LOGIN_RATE_LIMIT = { windowMs: WINDOW_MS, maxFailures: MAX_FAILURES } as const;
