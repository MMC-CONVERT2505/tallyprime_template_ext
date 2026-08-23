import { randomUUID } from 'crypto';
import Redis from 'ioredis';

/**
 * Compare-and-delete release script: only deletes `KEYS[1]` if it still
 * holds the token this caller acquired it with. Without this, a caller
 * whose critical section outlived its own lock TTL could delete a
 * DIFFERENT, newer holder's lock on release — a real (if unlikely) bug the
 * project's original ad-hoc bulk-export lock had (a plain unconditional
 * `DEL` in a `finally`), now fixed everywhere this utility is used instead.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Acquires `key` for at most `ttlMs`, returning a random token to release it
 * with, or `null` if someone else already holds it. Single-Redis-instance
 * safe (`SET key token PX ttlMs NX`) — no Redlock/multi-instance quorum,
 * which this project doesn't need: every lock built on this guards a
 * best-effort optimization or a single-process orchestration invariant, not
 * a hard correctness boundary (see lock.util.spec.ts and callers' own doc
 * comments for why losing a race here is always safe, just wasteful).
 */
export async function acquireLock(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
  return result === 'OK' ? token : null;
}

/**
 * Releases `key` only if it's still held by `token` — a safe no-op
 * (returns `false`) if it already expired or was taken over by a later
 * caller in the meantime.
 */
export async function releaseLock(redis: Redis, key: string, token: string): Promise<boolean> {
  const result = await redis.eval(RELEASE_SCRIPT, 1, key, token);
  return result === 1;
}

/**
 * Runs `fn` while holding `key`, always releasing afterward (success or
 * throw). Returns `null` without calling `fn` if the lock is already held —
 * callers decide what "already locked" means for them (reject, or fall
 * through to an unlocked fallback).
 */
export async function withLock<T>(
  redis: Redis,
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const token = await acquireLock(redis, key, ttlMs);
  if (!token) return null;
  try {
    return await fn();
  } finally {
    await releaseLock(redis, key, token);
  }
}
