import { DurableObject } from "cloudflare:workers";
import { emit, type Hook } from "./hooks.js";
import { createJobId, createTrialConfigs } from "./job.js";
import { runQueue } from "./queue.js";
import { computeStats } from "./stats.js";
import { runTrial } from "./trial.js";
import type {
  AgentTargetConfig,
  FetcherLike,
  JobConfig,
  JobResult,
  JobStatus,
  TrialConfig,
  TrialRecord,
  TrialStatus,
} from "./types.js";

const JOB_RESULT_KEY = "job:result";

function terminal(status: TrialStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function agentById(agents: readonly AgentTargetConfig[], agentId: string): AgentTargetConfig {
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error(`Unknown agent target "${agentId}" for trial dispatch`);
  return agent;
}

function jobStatus(records: readonly TrialRecord[]): JobStatus {
  if (records.some((record) => record.status === "running" || record.status === "pending")) {
    return "running";
  }
  return records.some((record) => record.status === "failed") ? "failed" : "completed";
}

function recordsById(records: readonly TrialRecord[]): Map<string, TrialRecord> {
  return new Map(records.map((record) => [record.config.id, record]));
}

function pendingRecord(config: TrialConfig): TrialRecord {
  return { config, status: "pending", tries: 0 };
}

function cancelRecord(record: TrialRecord, finishedAt: string): TrialRecord {
  return {
    ...record,
    status: "cancelled",
    finishedAt,
    durationMs: record.durationMs ?? 0,
  };
}

export abstract class JobObject<Env> extends DurableObject<Env> {
  protected abstract resolveAgent(target: AgentTargetConfig, trial: TrialConfig): FetcherLike;

  protected hooks(): readonly Hook[] {
    return [];
  }

  async start(config: JobConfig): Promise<JobResult> {
    const id = createJobId(config);
    const startedAt = new Date().toISOString();
    const start = Date.now();
    const stored = await this.get();
    const previous =
      stored?.id === id ? recordsById(stored.trials) : new Map<string, TrialRecord>();
    const trialConfigs = createTrialConfigs({ ...config, id });
    const trials = trialConfigs.map((trialConfig) => {
      const existing = previous.get(trialConfig.id);
      return existing && terminal(existing.status) ? existing : pendingRecord(trialConfig);
    });
    const trialIndex = new Map(trials.map((record, index) => [record.config.id, index]));
    const hooks = this.hooks();

    let persistChain = Promise.resolve();
    const buildResult = (finishedAt?: string): JobResult => ({
      id,
      name: config.name,
      status: jobStatus(trials),
      startedAt: stored?.id === id ? stored.startedAt : startedAt,
      finishedAt,
      durationMs: Date.now() - start,
      config: { ...config, id },
      trials: trials.map((record) => ({ ...record })),
      stats: computeStats(trials),
    });
    const persist = (finishedAt?: string): Promise<void> => {
      const snapshot = buildResult(finishedAt);
      persistChain = persistChain.then(() => this.ctx.storage.put(JOB_RESULT_KEY, snapshot));
      return persistChain;
    };

    await emit(hooks, { type: "job_started", jobId: id, at: startedAt });
    await persist();

    const remaining = trialConfigs.filter((trialConfig) => {
      const existing = previous.get(trialConfig.id);
      return !existing || !terminal(existing.status);
    });

    await runQueue(remaining, {
      concurrency: config.concurrency,
      hooks: [
        async (event) => {
          await emit(hooks, event);
          if (event.type === "trial_started") {
            const index = trialIndex.get(event.trialId);
            if (index === undefined) return;
            trials[index] = {
              ...trials[index],
              status: "running",
              startedAt: event.at,
            };
            await persist();
          }
          if (event.type === "trial_finished") {
            const index = trialIndex.get(event.trialId);
            if (index === undefined) return;
            trials[index] = event.record;
            await persist();
          }
        },
      ],
      runTrial: (trialConfig) =>
        runTrial(trialConfig, {
          agent: agentById(config.agents, trialConfig.agentId),
          resolveAgent: (target, trial) => this.resolveAgent(target, trial),
          retry: config.retry,
        }),
    });

    const finishedAt = new Date().toISOString();
    const result = buildResult(finishedAt);
    await persist(finishedAt);
    await emit(hooks, { type: "job_finished", jobId: id, result, at: finishedAt });
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
      terminal(record.status) ? record : cancelRecord(record, finishedAt),
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
