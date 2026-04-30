import type { RetryConfig } from "./types.js";

const DEFAULT_MIN_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_MULTIPLIER = 2;

export function retryDelayMs(attempt: number, config: RetryConfig = {}): number {
  const minDelay = config.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
  const maxDelay = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const multiplier = config.multiplier ?? DEFAULT_MULTIPLIER;
  return Math.min(minDelay * multiplier ** Math.max(0, attempt - 1), maxDelay);
}

export async function shouldRetry(
  error: unknown,
  attempt: number,
  config: RetryConfig = {},
): Promise<boolean> {
  const maxRetries = config.maxRetries ?? 0;
  if (attempt > maxRetries) return false;
  if (!config.retryOn) return true;
  return config.retryOn(error, attempt);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = {},
): Promise<{ value: T; tries: number }> {
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      const value = await operation();
      return { value, tries: attempt };
    } catch (error: unknown) {
      if (!(await shouldRetry(error, attempt, config))) {
        throw error;
      }
      await sleep(retryDelayMs(attempt, config));
    }
  }
}
