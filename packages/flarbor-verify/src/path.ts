import { throwVerifyError } from "./errors.js";

export function normalizeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    parts.includes("..") ||
    parts.includes("")
  ) {
    throwVerifyError("ARTIFACT_CAPTURE_FAILED", `Invalid relative verifier path: ${path}`);
  }
  return normalized;
}

export function normalizeRelativeDirectory(path: string | undefined): string {
  if (path === undefined || path === "." || path === "") return ".";
  return normalizeRelativePath(path);
}

export function normalizeSandboxRoot(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  if (
    !isAllowedSandboxRoot(normalized) ||
    normalized.includes("\0") ||
    parts.includes("..") ||
    parts.slice(1).includes("") ||
    !/^\/(?:workspace|logs)(?:\/[A-Za-z0-9._-]+)*$/.test(normalized)
  ) {
    throwVerifyError(
      "ARTIFACT_CAPTURE_FAILED",
      `Invalid verifier sandbox root: ${path}. Use an absolute path under /workspace/ or /logs/.`,
    );
  }
  return normalized;
}

function isAllowedSandboxRoot(path: string): boolean {
  return path.startsWith("/workspace/") || path === "/logs" || path.startsWith("/logs/");
}

export function joinSandboxPath(root: string, relativePath: string): string {
  return `${normalizeSandboxRoot(root)}/${normalizeRelativePath(relativePath)}`;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
