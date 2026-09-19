// Tiny TTL cache.
//
// Upstream is rate-limited and, more importantly, every ticker in a batch must
// see the same proxy reading. Without this, two tickers priced a second apart
// drift against different BTC/ETH snapshots and the batch is internally
// inconsistent.

interface Entry<T> {
  value: T;
  expires: number;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > now) return hit.value;

  // Collapse concurrent misses onto one upstream call.
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const p = fn()
    .then((value) => {
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}

export function invalidate(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

export function cacheStats(): { size: number; keys: string[] } {
  return { size: store.size, keys: [...store.keys()] };
}
