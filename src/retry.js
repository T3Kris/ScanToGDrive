/**
 * Retry an async function with exponential backoff. Used for transient Google
 * API failures (5xx, rate limiting). Permanent errors (4xx other than 429)
 * are not retried.
 */
export async function withRetry(fn, { retries = 4, baseDelayMs = 1000, onRetry } = {}) {
  let attempt = 0;
  // Total attempts = retries + 1 (the initial try).
  // Backoff: 1s, 2s, 4s, 8s (capped).
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isTransient(err)) {
        throw err;
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 8000);
      if (onRetry) onRetry({ attempt, delay, error: err });
      await sleep(delay);
    }
  }
}

export function isTransient(err) {
  const status = err?.code || err?.response?.status;
  if (status === 429) return true; // rate limited
  if (typeof status === 'number' && status >= 500) return true; // server error
  // Network-level errors without an HTTP status.
  const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];
  return transientCodes.includes(err?.code);
}

/** True when the error indicates we have exhausted our Gmail API quota. */
export function isQuotaExceeded(err) {
  const status = err?.code || err?.response?.status;
  if (status !== 403 && status !== 429) return false;
  const reason = err?.errors?.[0]?.reason || err?.response?.data?.error?.errors?.[0]?.reason;
  return ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(reason)
    || status === 429;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
