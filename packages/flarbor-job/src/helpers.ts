import type { AgentTargetConfig, JobStatus, TrialRecord, TrialStatus } from "./types.js";

export function agentById(
  agents: readonly AgentTargetConfig[],
  agentId: string,
): AgentTargetConfig {
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error(`Unknown agent target "${agentId}" for trial dispatch`);
  return agent;
}

export function jobStatus(records: readonly TrialRecord[]): JobStatus {
  if (records.some((record) => record.status === "running" || record.status === "pending")) {
    return "running";
  }
  return records.some((record) => record.status === "failed") ? "failed" : "completed";
}

export function terminal(status: TrialStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
