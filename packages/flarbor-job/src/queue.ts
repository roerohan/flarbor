import { emit, type Hook } from "./hooks.js";
import type { TrialConfig, TrialRecord, TrialRunner } from "./types.js";

export interface RunQueueOptions {
  concurrency?: number;
  runTrial: TrialRunner;
  hooks?: readonly Hook[];
}

export async function runQueue(
  configs: readonly TrialConfig[],
  options: RunQueueOptions,
): Promise<TrialRecord[]> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const results: TrialRecord[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < configs.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const config = configs[currentIndex];
      if (!config) continue;

      await emit(options.hooks, {
        type: "trial_started",
        jobId: config.jobId,
        trialId: config.id,
        at: new Date().toISOString(),
      });

      const record = await options.runTrial(config);
      results[currentIndex] = record;

      await emit(options.hooks, {
        type: "trial_finished",
        jobId: config.jobId,
        trialId: config.id,
        record,
        at: new Date().toISOString(),
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, configs.length) }, () => worker()));
  return results.filter((record): record is TrialRecord => record !== undefined);
}
