import { acquireLock, releaseLock, withLock } from './lock.util';

/** Minimal in-memory stand-in for the ioredis calls lock.util.ts actually
 *  makes — `set` with PX/NX semantics, and `eval` reproducing the fixed
 *  compare-and-delete release script (no real Lua interpreter needed since
 *  the script itself never changes). */
class FakeRedis {
  private readonly store = new Map<string, string>();

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async eval(_script: string, _numKeys: number, key: string, token: string): Promise<number> {
    if (this.store.get(key) === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
}

describe('lock.util', () => {
  describe('acquireLock / releaseLock', () => {
    it('acquires an unheld key and returns a token', async () => {
      const redis = new FakeRedis();
      const token = await acquireLock(redis as any, 'k', 1000);
      expect(token).not.toBeNull();
      expect(await redis.get('k')).toBe(token);
    });

    it('refuses to acquire a key someone else already holds', async () => {
      const redis = new FakeRedis();
      await acquireLock(redis as any, 'k', 1000);
      const second = await acquireLock(redis as any, 'k', 1000);
      expect(second).toBeNull();
    });

    it('releases only when the token still matches (compare-and-delete)', async () => {
      const redis = new FakeRedis();
      const token = await acquireLock(redis as any, 'k', 1000);

      const released = await releaseLock(redis as any, 'k', token!);

      expect(released).toBe(true);
      expect(await redis.get('k')).toBeNull();
    });

    it('does NOT release a key held by a different (later) token — the compare-and-delete safety guarantee', async () => {
      const redis = new FakeRedis();
      await acquireLock(redis as any, 'k', 1000);
      // Simulate this lock's TTL having already expired and a second caller
      // having since acquired it fresh.
      await redis.set('k', 'someone-elses-token');

      const released = await releaseLock(redis as any, 'k', 'stale-token');

      expect(released).toBe(false);
      expect(await redis.get('k')).toBe('someone-elses-token');
    });

    it('releasing an already-expired/never-held key is a safe no-op', async () => {
      const redis = new FakeRedis();
      await expect(releaseLock(redis as any, 'never-held', 'whatever')).resolves.toBe(false);
    });
  });

  describe('withLock', () => {
    it('runs fn while holding the lock, then releases it', async () => {
      const redis = new FakeRedis();

      const result = await withLock(redis as any, 'k', 1000, async () => {
        expect(await redis.get('k')).not.toBeNull();
        return 'done';
      });

      expect(result).toBe('done');
      expect(await redis.get('k')).toBeNull();
    });

    it('releases the lock even when fn throws', async () => {
      const redis = new FakeRedis();

      await expect(
        withLock(redis as any, 'k', 1000, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await redis.get('k')).toBeNull();
    });

    it('returns null without calling fn when the lock is already held', async () => {
      const redis = new FakeRedis();
      await acquireLock(redis as any, 'k', 1000);
      const fn = jest.fn();

      const result = await withLock(redis as any, 'k', 1000, fn);

      expect(result).toBeNull();
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
