import { emit, type Hook } from "./hooks.js";
import { runQueue } from "./queue.js";
import { computeStats } from "./stats.js";
import { runTrial } from "./trial.js";
import type {
  AgentResolver,
  AgentTargetConfig,
  JobConfig,
  JobResult,
  JobStatus,
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

export interface RunJobOptions {
  resolveAgent: AgentResolver;
  hooks?: readonly Hook[];
}

export async function runJob(config: JobConfig, options: RunJobOptions): Promise<JobResult> {
  const id = createJobId(config);
  const startedAt = new Date().toISOString();
  const start = Date.now();

  await emit(options.hooks, { type: "job_started", jobId: id, at: startedAt });

  const trialConfigs = createTrialConfigs({ ...config, id });
  const trials = await runQueue(trialConfigs, {
    concurrency: config.concurrency,
    hooks: options.hooks,
    runTrial: (trialConfig) =>
      runTrial(trialConfig, {
        agent: agentById(config.agents, trialConfig.agentId),
        resolveAgent: options.resolveAgent,
        retry: config.retry,
      }),
  });

  const finishedAt = new Date().toISOString();
  const result: JobResult = {
    id,
    name: config.name,
    status: jobStatus(trials),
    startedAt,
    finishedAt,
    durationMs: Date.now() - start,
    config: { ...config, id },
    trials,
    stats: computeStats(trials),
  };

  await emit(options.hooks, { type: "job_finished", jobId: id, result, at: finishedAt });
  return result;
}
