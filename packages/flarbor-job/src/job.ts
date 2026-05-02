import { agentById, jobStatus, terminal } from "./helpers.js";
import { emit, type Hook } from "./hooks.js";
import { runQueue } from "./queue.js";
import { computeStats } from "./stats.js";
import { runTrial } from "./trial.js";
import type {
  AgentResolver,
  JobConfig,
  JobResult,
  TrialConfig,
  TrialRecord,
} from "./types.js";

function stableId(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function createJobId(config: JobConfig): string {
  return (
    config.id ??
    `job-${stableId(JSON.stringify({ name: config.name, tasks: config.tasks, agents: config.agents }))}`
  );
}

function createTrialId(jobId: string, taskId: string, agentId: string, attempt: number): string {
  return `${jobId}:${taskId}:${agentId}:${attempt}`;
}

export function createTrialConfigs(config: JobConfig): TrialConfig[] {
  const jobId = createJobId(config);
  const attempts = Math.max(1, Math.floor(config.attempts ?? 1));
  const trials: TrialConfig[] = [];

  for (const task of config.tasks) {
    for (const agent of config.agents) {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        trials.push({
          id: createTrialId(jobId, task.id, agent.id, attempt),
          jobId,
          taskId: task.id,
          agentId: agent.id,
          attempt,
          task: task.task,
        });
      }
    }
  }

  return trials;
}

/**
 * Called after every trial starts or finishes so persistent orchestrators
 * (like {@link JobObject}) can snapshot intermediate state.
 *
 * Return `void` or a `Promise<void>` — the queue awaits the result before
 * continuing.
 */
export type PersistenceHook = (
  trials: readonly TrialRecord[],
  finishedAt?: string,
) => void | Promise<void>;

export interface RunJobOptions {
  resolveAgent: AgentResolver;
  hooks?: readonly Hook[];

  /**
   * Pre-existing trial records from a previous run (for resumption).
   * Trials whose status is terminal will be reused; the rest are re-run.
   */
  previousTrials?: ReadonlyMap<string, TrialRecord>;

  /**
   * Called after every trial state change so the caller can persist
   * intermediate state. Used by {@link JobObject} for DO storage.
   */
  onPersist?: PersistenceHook;
}

export async function runJob(config: JobConfig, options: RunJobOptions): Promise<JobResult> {
  const id = createJobId(config);
  const startedAt = new Date().toISOString();
  const start = Date.now();

  await emit(options.hooks, { type: "job_started", jobId: id, at: startedAt });

  const trialConfigs = createTrialConfigs({ ...config, id });
  const previous = options.previousTrials ?? new Map();

  // Build the mutable trials array, reusing terminal records from previous runs
  const trials: TrialRecord[] = trialConfigs.map((trialConfig) => {
    const existing = previous.get(trialConfig.id);
    if (existing && terminal(existing.status)) {
      return existing;
    }
    return { config: trialConfig, status: "pending" as const, tries: 0 };
  });

  const trialIndex = new Map(trials.map((record, index) => [record.config.id, index]));

  const buildResult = (finishedAt?: string): JobResult => ({
    id,
    name: config.name,
    status: jobStatus(trials),
    startedAt,
    finishedAt,
    durationMs: Date.now() - start,
    config: { ...config, id },
    trials: trials.map((record) => ({ ...record })),
    stats: computeStats(trials),
  });

  if (options.onPersist) {
    await options.onPersist(trials);
  }

  // Only run trials that are not already terminal
  const remaining = trialConfigs.filter((trialConfig) => {
    const existing = previous.get(trialConfig.id);
    return !existing || !terminal(existing.status);
  });

  await runQueue(remaining, {
    concurrency: config.concurrency,
    hooks: [
      async (event) => {
        await emit(options.hooks, event);
        if (event.type === "trial_started") {
          const index = trialIndex.get(event.trialId);
          if (index === undefined) return;
          trials[index] = {
            ...trials[index],
            status: "running",
            startedAt: event.at,
          };
          if (options.onPersist) await options.onPersist(trials);
        }
        if (event.type === "trial_finished") {
          const index = trialIndex.get(event.trialId);
          if (index === undefined) return;
          trials[index] = event.record;
          if (options.onPersist) await options.onPersist(trials);
        }
      },
    ],
    runTrial: (trialConfig) =>
      runTrial(trialConfig, {
        agent: agentById(config.agents, trialConfig.agentId),
        resolveAgent: options.resolveAgent,
        retry: config.retry,
      }),
  });

  const finishedAt = new Date().toISOString();
  const result = buildResult(finishedAt);

  if (options.onPersist) {
    await options.onPersist(trials, finishedAt);
  }

  await emit(options.hooks, { type: "job_finished", jobId: id, result, at: finishedAt });
  return result;
}
