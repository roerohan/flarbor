import { DurableObject } from "cloudflare:workers";
import { terminal } from "./helpers.js";
import { createJobId, runJob } from "./job.js";
import { computeStats } from "./stats.js";
import type { Hook } from "./hooks.js";
import type {
  AgentTargetConfig,
  JobConfig,
  JobResult,
  TrialConfig,
  TrialRecord,
} from "./types.js";
import type { FetcherLike } from "flarbor-shared";

const JOB_RESULT_KEY = "job:result";

/**
 * Abstract Durable Object base class for persistent job orchestration.
 *
 * Delegates all orchestration logic to {@link runJob}, injecting a
 * persistence hook that snapshots state to DO storage after every trial
 * state change. This keeps the orchestration logic in one place while
 * the DO owns only persistence, resumption, and cancellation.
 */
export abstract class JobObject<Env> extends DurableObject<Env> {
  protected abstract resolveAgent(target: AgentTargetConfig, trial: TrialConfig): FetcherLike;

  protected hooks(): readonly Hook[] {
    return [];
  }

  async start(config: JobConfig): Promise<JobResult> {
    const id = createJobId(config);

    // Load previous state for resumption
    const stored = await this.get();
    const previous = new Map<string, TrialRecord>();
    if (stored?.id === id) {
      for (const trial of stored.trials) {
        previous.set(trial.config.id, trial);
      }
    }

    // Chain persistence writes to avoid races
    let persistChain = Promise.resolve();
    const persist = (trials: readonly TrialRecord[], finishedAt?: string): Promise<void> => {
      const snapshot: JobResult = {
        id,
        name: config.name,
        status: finishedAt
          ? (trials.some((r) => r.status === "failed") ? "failed" : "completed")
          : "running",
        startedAt: stored?.id === id ? stored.startedAt : new Date().toISOString(),
        finishedAt,
        durationMs: 0,
        config: { ...config, id },
        trials: trials.map((record) => ({ ...record })),
        stats: computeStats(trials),
      };
      persistChain = persistChain.then(() => this.ctx.storage.put(JOB_RESULT_KEY, snapshot));
      return persistChain;
    };

    const result = await runJob(config, {
      resolveAgent: (target, trial) => this.resolveAgent(target, trial),
      hooks: this.hooks(),
      previousTrials: previous,
      onPersist: persist,
    });

    // Final persist with the complete result
    await this.ctx.storage.put(JOB_RESULT_KEY, result);
    return result;
  }

  async get(): Promise<JobResult | undefined> {
    return this.ctx.storage.get<JobResult>(JOB_RESULT_KEY);
  }

  async cancel(): Promise<JobResult> {
    const current = await this.get();
    if (!current) throw new Error("Cannot cancel job because no job state is stored yet.");

    const finishedAt = new Date().toISOString();
    const trials = current.trials.map((record) =>
      terminal(record.status)
        ? record
        : {
            ...record,
            status: "cancelled" as const,
            finishedAt,
            durationMs: record.durationMs ?? 0,
          },
    );
    const result: JobResult = {
      ...current,
      status: "cancelled",
      finishedAt,
      trials,
      stats: computeStats(trials),
    };
    await this.ctx.storage.put(JOB_RESULT_KEY, result);
    return result;
  }
}
