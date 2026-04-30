import type { JobGroupStats, JobStats, TrialRecord } from "./types.js";

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeGroupStats(records: readonly TrialRecord[]): JobGroupStats {
  const total = records.length;
  const pending = records.filter((record) => record.status === "pending").length;
  const running = records.filter((record) => record.status === "running").length;
  const succeeded = records.filter((record) => record.status === "succeeded").length;
  const failed = records.filter((record) => record.status === "failed").length;
  const cancelled = records.filter((record) => record.status === "cancelled").length;
  const rewardScores = records
    .map((record) => record.result?.reward?.score)
    .filter((score): score is number => typeof score === "number");
  const tokenTotals = records
    .map((record) => record.result?.usage?.totalTokens)
    .filter((tokens): tokens is number => typeof tokens === "number");

  return {
    total,
    pending,
    running,
    succeeded,
    failed,
    cancelled,
    successRate: total === 0 ? 0 : succeeded / total,
    averageReward: average(rewardScores),
    averageTokens: average(tokenTotals),
  };
}

function groupBy(
  records: readonly TrialRecord[],
  keyFor: (record: TrialRecord) => string,
): Record<string, TrialRecord[]> {
  const grouped: Record<string, TrialRecord[]> = {};
  for (const record of records) {
    const key = keyFor(record);
    const existing = grouped[key];
    if (existing) {
      existing.push(record);
    } else {
      grouped[key] = [record];
    }
  }
  return grouped;
}

function computeGroupedStats(
  records: readonly TrialRecord[],
  keyFor: (record: TrialRecord) => string,
): Record<string, JobGroupStats> {
  const grouped = groupBy(records, keyFor);
  const stats: Record<string, JobGroupStats> = {};
  for (const [key, group] of Object.entries(grouped)) {
    stats[key] = computeGroupStats(group);
  }
  return stats;
}

export function computeStats(records: readonly TrialRecord[]): JobStats {
  return {
    ...computeGroupStats(records),
    byAgent: computeGroupedStats(records, (record) => record.config.agentId),
    byTask: computeGroupedStats(records, (record) => record.config.taskId),
  };
}
