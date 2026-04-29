import { ContainerCommandError } from "./types.js";

export function normalizeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");

  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    parts.includes("..") ||
    parts.includes("") ||
    normalized.includes("\0")
  ) {
    throw new ContainerCommandError(
      "INVALID_PATH",
      `Invalid relative path for container workspace sync: ${path}`,
    );
  }

  return normalized;
}

export function normalizeRelativeDirectory(path: string | undefined): string {
  if (path === undefined || path === "." || path === "") return ".";
  return normalizeRelativePath(path);
}

export function joinSandboxPath(root: string, relativePath: string): string {
  if (relativePath === ".") return root;
  return `${root}/${normalizeRelativePath(relativePath)}`;
}

export function normalizeSandboxRoot(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const parts = normalized.split("/");

  if (
    !normalized.startsWith("/workspace/") ||
    parts.includes("..") ||
    parts.slice(1).includes("") ||
    normalized.includes("\0") ||
    !/^\/workspace\/[A-Za-z0-9._/-]+$/.test(normalized)
  ) {
    throw new ContainerCommandError(
      "INVALID_PATH",
      `Invalid container workspace root: ${path}. Use an absolute path under /workspace/.`,
    );
  }

  return normalized;
}
