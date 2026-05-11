import { matchesGlob } from "flarbor-shared";
import { joinSandboxPath, normalizeRelativePath, normalizeSandboxRoot } from "./paths.js";
import type {
  WorkspaceEntry,
  WorkspaceLike,
  WorkspaceSyncOptions,
  WorkspaceSyncResult,
} from "./types.js";

const DEFAULT_INCLUDE = ["**/*"] as const;
const DEFAULT_EXCLUDE = [".git/**", "node_modules/**", ".wrangler/**"] as const;

interface SandboxFileWriter {
  exec?(command: string, options?: { timeout?: number; origin?: string }): Promise<unknown>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<unknown>;
}

export async function syncWorkspaceToSandbox(
  workspace: WorkspaceLike,
  sandbox: SandboxFileWriter,
  options: WorkspaceSyncOptions = {},
): Promise<WorkspaceSyncResult> {
  const targetDir = normalizeSandboxRoot(options.targetDir ?? "/workspace/repo");
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])];
  const paths = await listIncludedFiles(workspace, include, exclude);
  const createdDirs = new Set<string>([targetDir]);
  let filesWritten = 0;
  let filesSkipped = 0;
  let bytesWritten = 0;

  for (const path of paths) {
    const file = await readWorkspaceFile(workspace, path);
    if (file === null) {
      filesSkipped++;
      continue;
    }

    const targetPath = joinSandboxPath(targetDir, path);
    await ensureParentDirectory(sandbox, targetPath, createdDirs);
    await sandbox.writeFile(targetPath, file.content, file.options);
    filesWritten++;
    bytesWritten += file.bytes;
  }

  return { filesWritten, filesSkipped, bytesWritten };
}

async function ensureParentDirectory(
  sandbox: SandboxFileWriter,
  targetPath: string,
  createdDirs: Set<string>,
): Promise<void> {
  const lastSlash = targetPath.lastIndexOf("/");
  if (lastSlash <= 0) return;
  const parent = targetPath.slice(0, lastSlash);
  if (createdDirs.has(parent)) return;
  if (sandbox.exec) {
    await sandbox.exec(`mkdir -p ${shellQuote(parent)}`, { timeout: 30_000, origin: "internal" });
  }
  createdDirs.add(parent);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readWorkspaceFile(
  workspace: WorkspaceLike,
  path: string,
): Promise<{ content: string; bytes: number; options?: { encoding?: string } } | null> {
  const text = await workspace.readFile(path);
  if (text !== null) {
    return { content: text, bytes: new TextEncoder().encode(text).byteLength };
  }

  if (!workspace.readFileBytes) return null;
  const bytes = await workspace.readFileBytes(path);
  if (bytes === null) return null;

  return {
    content: bytesToBase64(bytes),
    bytes: bytes.byteLength,
    options: { encoding: "base64" },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.slice(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function listIncludedFiles(
  workspace: WorkspaceLike,
  include: readonly string[] = DEFAULT_INCLUDE,
  exclude: readonly string[] = DEFAULT_EXCLUDE,
): Promise<string[]> {
  const seen = new Set<string>();

  if (workspace.glob) {
    for (const pattern of include) {
      const entries = await workspace.glob(pattern);
      for (const entry of entries) addEntry(seen, entry.path, entry.type, include, exclude);
    }
  } else {
    const entries = await listFilesRecursively(workspace, "");
    for (const entry of entries) addEntry(seen, entry.path, entry.type, include, exclude);
  }

  return [...seen].sort();
}

async function listFilesRecursively(
  workspace: WorkspaceLike,
  dir: string,
): Promise<WorkspaceEntry[]> {
  const entries = await workspace.readDir(dir || undefined);
  const files: WorkspaceEntry[] = [];

  for (const entry of entries) {
    if (entry.type === "file") {
      files.push(entry);
    } else if (entry.type === "directory") {
      files.push(...(await listFilesRecursively(workspace, entry.path)));
    }
  }

  return files;
}

function addEntry(
  seen: Set<string>,
  path: string,
  type: string,
  include: readonly string[],
  exclude: readonly string[],
): void {
  if (type !== "file") return;
  const normalized = normalizeRelativePath(normalizeWorkspaceEntryPath(path));
  if (!matchesGlob(normalized, include)) return;
  if (matchesGlob(normalized, exclude)) return;
  seen.add(normalized);
}

function normalizeWorkspaceEntryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}
