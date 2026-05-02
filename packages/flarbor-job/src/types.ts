import type { TaskConfig, TrialResult } from "flarbor";
import type { FetcherLike } from "flarbor-shared";

export type { FetcherLike } from "flarbor-shared";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type TrialStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface NamedTaskConfig {
  id: string;
  name?: string;
  task: TaskConfig;
}

export interface AgentTargetConfig {
  id: string;
  name?: string;
  kind: "durable_object";
  namespace: string;
}

export type RetryDecision = (error: unknown, attempt: number) => boolean | Promise<boolean>;

export interface RetryConfig {
  maxRetries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  retryOn?: RetryDecision;
}

export interface JobConfig {
  id?: string;
  name?: string;
  tasks: NamedTaskConfig[];
  agents: AgentTargetConfig[];
  attempts?: number;
  concurrency?: number;
  retry?: RetryConfig;
  createdAt?: string;
}

export interface TrialConfig {
  id: string;
  jobId: string;
  taskId: string;
  agentId: string;
  attempt: number;
  task: TaskConfig;
}

export interface TrialRecord {
  config: TrialConfig;
  status: TrialStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  tries: number;
  result?: TrialResult;
  error?: string;
}

export interface JobGroupStats {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  successRate: number;
  averageReward?: number;
  averageTokens?: number;
}

export interface JobStats extends JobGroupStats {
  byAgent: Record<string, JobGroupStats>;
  byTask: Record<string, JobGroupStats>;
}

export interface JobResult {
  id: string;
  name?: string;
  status: JobStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  config: JobConfig;
  trials: TrialRecord[];
  stats: JobStats;
}

export type AgentResolver = (target: AgentTargetConfig, trial: TrialConfig) => FetcherLike;

export type TrialRunner = (config: TrialConfig) => Promise<TrialRecord>;

