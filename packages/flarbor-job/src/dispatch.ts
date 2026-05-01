import type { TaskConfig, TrialResult } from "flarbor";
import type { FetcherLike } from "./types.js";

export type DispatchErrorKind = "fetch_failed" | "invalid_result" | "invalid_json";

export class DispatchError extends Error {
  readonly kind: DispatchErrorKind;
  readonly status?: number;

  constructor(kind: DispatchErrorKind, message: string, status?: number) {
    super(message);
    this.name = "DispatchError";
    this.kind = kind;
    this.status = status;
  }
}

function isTrialResult(value: unknown): value is TrialResult {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.success === "boolean" &&
    typeof v.branch === "string" &&
    typeof v.commitSha === "string" &&
    Array.isArray(v.filesChanged)
  );
}

/**
 * Dispatch a task to a Flarbor agent target without importing the core package at runtime.
 */
export async function dispatchTask(stub: FetcherLike, task: TaskConfig): Promise<TrialResult> {
  const agentName = `${task.repoUrl}:${task.branch ?? "default"}`;

  let response: Response;
  try {
    response = await stub.fetch(
      new Request("http://internal/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-partykit-room": agentName,
        },
        body: JSON.stringify(task),
      }),
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DispatchError("fetch_failed", `Failed to reach agent: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch {
    const text = await response.text().catch(() => "(unreadable)");
    throw new DispatchError(
      "invalid_json",
      `Agent returned ${response.status} with invalid JSON: ${text}`,
      response.status,
    );
  }

  if (isTrialResult(parsed)) return parsed;
  const preview = JSON.stringify(parsed).slice(0, 500);
  throw new DispatchError(
    "invalid_result",
    `Agent returned invalid TrialResult (status ${response.status}): ${preview}`,
    response.status,
  );
}
