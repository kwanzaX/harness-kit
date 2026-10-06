// Timeouts and retries for model and tool calls. Every call the harness makes goes through here.

export class TimeoutError extends Error {
  constructor(ms) {
    super(`timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Runs fn(signal) and rejects with TimeoutError after ms. The AbortSignal lets
 * well-behaved callees (fetch, model SDKs) stop work instead of leaking it.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} fn
 * @param {number} ms
 * @returns {Promise<T>}
 */
export async function withTimeout(fn, ms) {
  if (!ms || ms === Infinity) return fn(new AbortController().signal);
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new TimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retries fn with exponential backoff and full jitter. Errors with retryable === false stop at once.
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{ retries?: number, baseMs?: number, maxMs?: number, sleep?: (ms: number) => Promise<void>, onRetry?: (err: Error, attempt: number) => void }} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const { retries = 2, baseMs = 200, maxMs = 5000, sleep = defaultSleep, onRetry } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (err && err.retryable === false) throw err;
      if (attempt === retries) break;
      onRetry?.(err, attempt + 1);
      const cap = Math.min(maxMs, baseMs * 2 ** attempt);
      await sleep(Math.random() * cap);
    }
  }
  throw lastErr;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
