import { dispatchTask, DispatchError, agentNameFor } from "flarbor-shared/dispatch";
import type { TaskConfig, TrialResult } from "./types.js";

/**
 * Dispatch a task to a FlarborEnvironment Durable Object stub.
 *
 * Thin wrapper around `dispatchTask` from flarbor-shared that never throws.
 * Infrastructure errors are caught and returned as failed `TrialResult` objects
 * so callers (like the code-change environment) can always treat the return
 * value as a valid result.
 */
export async function runTask(
  stub: { fetch: (request: Request) => Promise<Response> },
  task: TaskConfig,
): Promise<TrialResult> {
  const agentName = agentNameFor(task);
  const start = Date.now();
  console.log(
    `[flarbor:runner] dispatch agent=${agentName} repo=${task.repoUrl} branch=${task.branch ?? "(auto)"}`,
  );

  try {
    const result = await dispatchTask<TrialResult>(stub, task);

    console.log(
      `[flarbor:runner] result agent=${agentName}` +
        ` success=${result.success}` +
        ` branch=${result.branch}` +
        ` files_changed=${result.filesChanged.length}` +
        ` duration=${Date.now() - start}ms` +
        (result.error ? ` error=${result.error}` : ""),
    );
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = err instanceof DispatchError ? err.kind : "unknown";
    console.error(
      `[flarbor:runner] dispatch failed agent=${agentName} kind=${kind} duration=${Date.now() - start}ms error=${message}`,
    );
    return {
      success: false,
      branch: task.branch ?? "",
      commitSha: "",
      filesChanged: [],
      error: message,
    };
  }
}
