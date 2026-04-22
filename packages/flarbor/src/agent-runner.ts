import type { TaskConfig, TrialResult } from "./types.js";

/**
 * Run a task against a Flarbor environment Durable Object.
 *
 * This is a convenience function for Worker fetch handlers that need
 * to dispatch tasks to a FlarborEnvironment DO instance. It handles
 * request construction, response parsing, and error wrapping.
 *
 * @example
 * ```typescript
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const task = await request.json() as TaskConfig;
 *     const stub = env.MY_AGENT.getByName(`${task.repoUrl}:${task.branch}`);
 *     const result = await runTask(stub, task);
 *     return Response.json(result);
 *   }
 * };
 * ```
 */
export async function runTask(
  stub: { fetch: (request: Request) => Promise<Response> },
  task: TaskConfig,
): Promise<TrialResult> {
  let response: Response;

  try {
    // Derive a stable name for the DO from the task config.
    // Sent via x-partykit-room header so the Agent/PartyServer framework
    // can hydrate this.name before onStart accesses it.
    const agentName = `${task.repoUrl}:${task.branch ?? "default"}`;
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
    return (await response.json()) as TrialResult;
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
