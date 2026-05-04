import { describe, expect, it } from "vitest";

import {
  commandOutputContains,
  csvCellEquals,
  fileContains,
  httpStatusEquals,
  jsonPathEquals,
  runVerifyCriteria,
} from "./criteria.js";
import type { VerifyContext, VerifyExec, WorkspaceLike } from "./types.js";

const workspace: WorkspaceLike = {
  async readFile(path) {
    if (path === "package.json") return '{"scripts":{"test":"vitest"}}';
    if (path === "README.md") return "A documented health endpoint";
    if (path === "data.csv") return "name,score\napi,1\ndocs,0";
    return null;
  },
  async readDir() {
    return [];
  },
};

const exec: VerifyExec = {
  async run(request) {
    return {
      success: true,
      exitCode: 0,
      stdout: request.command === "npm test" ? "tests passed" : "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      outputTruncated: false,
    };
  },
};

function ctx(): VerifyContext {
  return {
    workspace,
    filesChanged: [],
    success: true,
    capabilities: {
      exec,
      fetch: async () => new Response("ok", { status: 200 }),
    },
  };
}

describe("criteria", () => {
  it("runs pure, fetch, and exec criteria", async () => {
    const result = await runVerifyCriteria(
      [
        fileContains({ path: "README.md", text: "health" }),
        jsonPathEquals({ path: "package.json", jsonPath: "scripts.test", expected: "vitest" }),
        csvCellEquals({ path: "data.csv", row: 1, column: "score", expected: "1" }),
        httpStatusEquals({ url: "https://example.test", status: 200 }),
        commandOutputContains({ command: "npm test", text: "passed" }),
      ],
      ctx(),
    );

    expect(result.rewards).toEqual({
      file_contains: 1,
      json_path_equals: 1,
      csv_cell_equals: 1,
      http_status_equals: 1,
      command_output_contains: 1,
    });
  });

  it("returns zero score details when exec is unavailable", async () => {
    const result = await runVerifyCriteria(
      [commandOutputContains({ command: "npm test", text: "ok" })],
      {
        workspace,
        filesChanged: [],
        success: true,
        capabilities: {},
      },
    );

    expect(result.rewards.command_output_contains).toBe(0);
    expect(result.details).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "EXEC_UNAVAILABLE" }) }),
    ]);
  });

  it("uses exec for localhost HTTP checks", async () => {
    const requests: string[] = [];
    const result = await runVerifyCriteria(
      [httpStatusEquals({ url: "http://localhost:8787/health", status: 204 })],
      {
        workspace,
        filesChanged: [],
        success: true,
        capabilities: {
          exec: {
            async run(request) {
              requests.push(request.command);
              return {
                success: true,
                exitCode: 0,
                stdout: "ok\n__FLARBOR_STATUS__:204",
                stderr: "",
                durationMs: 1,
                timedOut: false,
                outputTruncated: false,
              };
            },
          },
        },
      },
    );

    expect(result.rewards.http_status_equals).toBe(1);
    expect(requests[0]).toContain("curl");
  });
});
