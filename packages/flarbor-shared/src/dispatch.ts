import { isTrialResult } from "./trial-result.js";
import type { TrialResultShape } from "./trial-result.js";

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

export interface DispatchTaskConfig {
  repoUrl: string;
  branch?: string;
}

export interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

/** Derive a stable room/agent name from a task config. */
export function agentNameFor(task: DispatchTaskConfig): string {
  return `${task.repoUrl}:${task.branch ?? "default"}`;
}

/**
 * Dispatch a task to a Flarbor agent target.
 *
 * Throws {@link DispatchError} on infrastructure failures (network errors,
 * invalid JSON, or invalid response shapes). Returns a valid result
 * on success — including when the agent itself reports `success: false`.
 */
export async function dispatchTask<T extends TrialResultShape = TrialResultShape>(
  stub: FetcherLike,
  task: DispatchTaskConfig,
): Promise<T> {
  const agentName = agentNameFor(task);

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

  if (isTrialResult(parsed)) return parsed as T;
  const preview = JSON.stringify(parsed).slice(0, 500);
  throw new DispatchError(
    "invalid_result",
    `Agent returned invalid TrialResult (status ${response.status}): ${preview}`,
    response.status,
  );
}
