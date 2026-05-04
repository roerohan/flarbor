import { createVerifyError, throwVerifyError } from "./errors.js";
import type { RewardResultLike, VerifyOutput, VerifyResult } from "./types.js";

export function rewards(
  scores: Record<string, number | boolean>,
  options: { details?: unknown } = {},
): VerifyOutput {
  return {
    rewards: normalizeRewards(scores),
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}

export function normalizeRewards(scores: Record<string, number | boolean>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [name, raw] of Object.entries(scores)) {
    const value = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
    if (!Number.isFinite(value)) {
      throwVerifyError(
        "REWARD_VALUE_INVALID",
        `Reward "${name}" must be a finite number, got ${String(value)}.`,
      );
    }
    normalized[name] = value;
  }
  return normalized;
}

export function parseRewardText(content: string): Record<string, number> {
  if (content.length === 0) {
    throwVerifyError("REWARD_FILE_EMPTY", "Reward text file is empty.");
  }

  const value = Number(content.trim());
  if (!Number.isFinite(value)) {
    throwVerifyError(
      "REWARD_FILE_MALFORMED",
      "Reward text file must contain a single finite number.",
    );
  }
  return { reward: value };
}

export function parseRewardJson(content: string): Record<string, number> {
  if (content.length === 0) {
    throwVerifyError("REWARD_FILE_EMPTY", "Reward JSON file is empty.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throwVerifyError("REWARD_FILE_MALFORMED", "Reward JSON file is not valid JSON.", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throwVerifyError("REWARD_FILE_MALFORMED", "Reward JSON file must contain an object.");
  }

  const entries = Object.entries(parsed);
  const scores: Record<string, number> = {};
  for (const [name, value] of entries) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throwVerifyError("REWARD_VALUE_INVALID", `Reward "${name}" must be a finite number.`, {
        value,
      });
    }
    scores[name] = value;
  }
  return scores;
}

export function toRewardResult(result: VerifyResult): RewardResultLike {
  if (result.kind === "error") {
    const score = 0;
    return {
      score,
      totalCriteria: 1,
      errors: 1,
      rewards: [
        {
          name: "verification",
          score,
          aggregation: "weighted_mean",
          criteria: [{ name: result.error.code, score, weight: 1, error: result.error.message }],
        },
      ],
    };
  }

  const criteria = Object.entries(result.rewards).map(([name, score]) => ({
    name,
    score,
    weight: 1,
  }));
  const score = criteria.length
    ? criteria.reduce((sum, criterion) => sum + criterion.score, 0) / criteria.length
    : 0;
  return {
    score,
    totalCriteria: criteria.length,
    errors: 0,
    rewards: [{ name: "verification", score, aggregation: "weighted_mean", criteria }],
  };
}

export function invalidRewardError(error: unknown) {
  if (error instanceof Error) {
    return createVerifyError("REWARD_VALUE_INVALID", error.message);
  }
  return createVerifyError("REWARD_VALUE_INVALID", "Verifier returned invalid rewards.", error);
}
