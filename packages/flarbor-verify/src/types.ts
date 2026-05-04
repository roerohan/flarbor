import type { SandboxNamespace, WorkspaceLike } from "flarbor-container";

export type { SandboxNamespace, WorkspaceLike };

export interface TokenUsageLike {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type VerifyMode = "native" | "dynamic" | "script";

export type VerifyErrorCode =
  | "VERIFIER_FAILED"
  | "DYNAMIC_VERIFIER_FAILED"
  | "EXEC_UNAVAILABLE"
  | "EXEC_FAILED"
  | "TEST_SCRIPT_NOT_FOUND"
  | "TEST_UPLOAD_FAILED"
  | "SCRIPT_EXECUTION_FAILED"
  | "REWARD_FILE_NOT_FOUND"
  | "REWARD_FILE_EMPTY"
  | "REWARD_FILE_MALFORMED"
  | "REWARD_VALUE_INVALID"
  | "UNSUPPORTED_OS"
  | "ARTIFACT_CAPTURE_FAILED"
  | "SANDBOX_ERROR";

export interface VerifyError {
  code: VerifyErrorCode;
  message: string;
  details?: unknown;
}

export interface VerifyExecRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  include?: readonly string[];
  exclude?: readonly string[];
  captureFiles?: readonly string[];
}

export interface VerifyExecResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  files?: readonly CapturedArtifact[];
}

export interface VerifyExec {
  run(request: VerifyExecRequest): Promise<VerifyExecResult>;
}

export interface VerifyCapabilities {
  fetch?: typeof fetch;
  exec?: VerifyExec;
  readArtifact?: (path: string) => Promise<Uint8Array | string | null>;
  writeArtifact?: (path: string, content: Uint8Array | string) => Promise<void>;
}

export interface VerifyContext {
  workspace: WorkspaceLike;
  filesChanged: readonly string[];
  success: boolean;
  usage?: TokenUsageLike;
  trajectory?: unknown;
  metadata?: Record<string, unknown>;
  capabilities: VerifyCapabilities;
}

export interface VerifyOutput {
  rewards: Record<string, number>;
  details?: unknown;
  logs?: VerifierLogs;
  artifacts?: readonly CapturedArtifact[];
}

export interface Verifier {
  name: string;
  run(ctx: VerifyContext): Promise<VerifyOutput> | VerifyOutput;
}

export interface VerifyConfig {
  verifier: Verifier;
  context: VerifyContext;
}

export interface DynamicVerifierAdapter {
  run(ctx: VerifyContext): Promise<VerifyOutput>;
}

export interface DynamicVerifyConfig {
  adapter: DynamicVerifierAdapter;
  context: VerifyContext;
}

export interface VerifierLogs {
  stdout: string;
  stderr: string;
  testStdout?: string;
  outputTruncated: boolean;
}

export interface CapturedArtifact {
  path: string;
  content: string;
  truncated?: boolean;
}

export interface ArtifactSpec {
  path: string;
  maxBytes?: number;
}

export type VerifyResult =
  | {
      kind: "verified";
      rewards: Record<string, number>;
      details?: unknown;
      logs: VerifierLogs;
      artifacts: readonly CapturedArtifact[];
      durationMs: number;
      mode: VerifyMode;
    }
  | {
      kind: "error";
      error: VerifyError;
      rewards?: Record<string, number>;
      details?: unknown;
      logs?: VerifierLogs;
      artifacts: readonly CapturedArtifact[];
      durationMs: number;
      mode: VerifyMode;
    };

export interface TestFile {
  path: string;
  content: string | Uint8Array;
}

export type TestSource =
  | { kind: "files"; files: readonly TestFile[] }
  | {
      kind: "workspace";
      workspace: WorkspaceLike;
      include?: readonly string[];
      exclude?: readonly string[];
    }
  | { kind: "skip-upload" };

export interface VerifyScriptConfig {
  sandbox: SandboxNamespace;
  sandboxId: string;
  workspace: WorkspaceLike;
  tests: TestSource;
  os?: "linux" | "windows";
  scriptName?: string;
  workspaceRoot?: string;
  testsDir?: string;
  logsDir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  artifacts?: readonly ArtifactSpec[];
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface SandboxExecConfig {
  sandbox: SandboxNamespace;
  sandboxId: string;
  workspace: WorkspaceLike;
  root?: string;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  keepAlive?: boolean;
  sleepAfter?: string;
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface CriterionDetail {
  name: string;
  score: number;
  raw?: unknown;
  error?: VerifyError;
  stdout?: string;
  stderr?: string;
}

export interface VerifyCriterion {
  name: string;
  requiresExec: boolean;
  evaluate(ctx: VerifyContext): Promise<CriterionDetail>;
}

export interface RewardResultLike {
  score: number;
  rewards: Array<{
    name: string;
    score: number;
    criteria: Array<{ name: string; score: number; weight: number; error?: string }>;
    aggregation: "weighted_mean";
  }>;
  totalCriteria: number;
  errors: number;
}
