import { dispatchTask } from "./dispatch.js";
import type {
  AgentResolver,
  AgentTargetConfig,
  RetryConfig,
  TrialConfig,
  TrialRecord,
} from "./types.js";
import { withRetry } from "./retry.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RunTrialOptions {
  agent: AgentTargetConfig;
  resolveAgent: AgentResolver;
  retry?: RetryConfig;
}

export async function runTrial(
  config: TrialConfig,
  options: RunTrialOptions,
): Promise<TrialRecord> {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  try {
    const { value: result, tries } = await withRetry(async () => {
      const stub = options.resolveAgent(options.agent, config);
      return dispatchTask(stub, config.task);
    }, options.retry);

    const finishedAt = new Date().toISOString();
    return {
      config,
      status: result.success ? "succeeded" : "failed",
      startedAt,
      finishedAt,
      durationMs: Date.now() - start,
      tries,
      result,
      error: result.error,
    };
  } catch (error: unknown) {
    const finishedAt = new Date().toISOString();
    return {
      config,
      status: "failed",
      startedAt,
      finishedAt,
      durationMs: Date.now() - start,
      tries: (options.retry?.maxRetries ?? 0) + 1,
      error: errorMessage(error),
    };
  }
}
