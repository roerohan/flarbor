/**
 * Shared test utilities for building mock WorkspaceLike and CriterionContext objects.
 *
 * Import from "flarbor-shared/testing" in test files.
 */
import type { CriterionContext, WorkspaceLike } from "./types.js";

export type { CriterionContext } from "./types.js";

/**
 * Build a mock WorkspaceLike from a flat file map.
 */
export function mockWorkspace(
  files: Record<string, string> = {},
): WorkspaceLike {
  return {
    readFile: async (path: string) => files[path] ?? null,
    readDir: async () =>
      Object.keys(files).map((p) => ({ path: p, type: "file" })),
  };
}

/**
 * Build a CriterionContext with sensible defaults.
 *
 * When `files` is provided, a mock workspace is created from the file map.
 * If `filesChanged` is not explicitly set, it defaults to the keys of `files`.
 */
export function mockContext(
  overrides: Partial<CriterionContext> & { files?: Record<string, string> } = {},
): CriterionContext {
  const { files, ...rest } = overrides;
  return {
    workspace: files ? mockWorkspace(files) : mockWorkspace(),
    filesChanged: files && !rest.filesChanged ? Object.keys(files) : [],
    success: true,
    ...rest,
  };
}
