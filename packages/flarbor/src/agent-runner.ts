import type { TaskConfig, TrialResult } from "./types.js";

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
 * Dispatch a task to a FlarborEnvironment Durable Object stub.
 * Handles request construction, response parsing, and error wrapping.
 */
export async function runTask(
  stub: { fetch: (request: Request) => Promise<Response> },
  task: TaskConfig,
): Promise<TrialResult> {
  const agentName = `${task.repoUrl}:${task.branch ?? "default"}`;
  const start = Date.now();
  console.log(
    `[flarbor:runner] dispatch agent=${agentName} repo=${task.repoUrl} branch=${task.branch ?? "(auto)"}`,
  );

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
    console.error(
      `[flarbor:runner] dispatch failed agent=${agentName} duration=${Date.now() - start}ms error=${message}`,
    );
    return {
      success: false,
      branch: task.branch ?? "",
      commitSha: "",
      filesChanged: [],
      error: `Failed to reach agent: ${message}`,
    };
  }

  console.log(
    `[flarbor:runner] agent responded agent=${agentName} status=${response.status} duration=${Date.now() - start}ms`,
  );

  try {
    const parsed: unknown = await response.json();
    if (isTrialResult(parsed)) {
      console.log(
        `[flarbor:runner] result agent=${agentName}` +
          ` success=${parsed.success}` +
          ` branch=${parsed.branch}` +
          ` files_changed=${parsed.filesChanged.length}` +
          ` duration=${Date.now() - start}ms` +
          (parsed.error ? ` error=${parsed.error}` : ""),
      );
      return parsed;
    }
    console.error(
      `[flarbor:runner] invalid response shape agent=${agentName} status=${response.status}`,
    );
    return {
      success: false,
      branch: task.branch ?? "",
      commitSha: "",
      filesChanged: [],
      error: `Agent returned invalid TrialResult (status ${response.status})`,
    };
  } catch {
    const text = await response.text().catch(() => "(unreadable)");
    console.error(
      `[flarbor:runner] response parse failed agent=${agentName} status=${response.status} body=${text.slice(0, 200)}`,
    );
    return {
      success: false,
      branch: task.branch ?? "",
      commitSha: "",
      filesChanged: [],
      error: `Agent returned ${response.status}: ${text}`,
    };
  }
}
