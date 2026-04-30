import type { TaskConfig, TrialResult } from "flarbor";
import type { FetcherLike } from "./types.js";

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
    return {
      success: false,
      branch: task.branch ?? "",
      commitSha: "",
      filesChanged: [],
      error: `Failed to reach agent: ${message}`,
    };
  }

  try {
    const parsed: unknown = await response.json();
    if (isTrialResult(parsed)) return parsed;
    return {
      success: false,
      branch: task.branch ?? "",
      commitSha: "",
      filesChanged: [],
      error: `Agent returned invalid TrialResult (status ${response.status})`,
    };
  } catch {
    const text = await response.text().catch(() => "(unreadable)");
    return {
      success: false,
      branch: task.branch ?? "",
      commitSha: "",
      filesChanged: [],
      error: `Agent returned ${response.status}: ${text}`,
    };
  }
}
