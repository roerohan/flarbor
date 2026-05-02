import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { Workspace } from "@cloudflare/think";
import { z } from "zod";
import { FlarborEnvironment } from "flarbor";
import type { EnvironmentConfig, FlarborEnv, TaskConfig, TrialResult, RewardResult } from "flarbor";
import { run as scoreRun, reward, criterion } from "flarbor-reward";
import type { CriterionContext } from "flarbor-reward";
import { JobObject, createJobId, runJob } from "flarbor-job";
import type { AgentTargetConfig, FetcherLike, JobConfig, JobResult, TrialConfig } from "flarbor-job";

interface Env extends FlarborEnv {
  REPO_AUDIT_AGENT: DurableObjectNamespace<RepoAuditAgent>;
  REPO_AUDIT_JOB: DurableObjectNamespace<RepoAuditJob>;
  ANTHROPIC_API_KEY?: string;
  MODEL_NAME?: string;
}

type Category = "documentation" | "testing" | "packaging" | "maintainability" | "deployment";

interface RepoAuditReport {
  repoUrl: string;
  model: string;
  summary: string;
  scores: {
    documentation: number;
    testing: number;
    packaging: number;
    maintainability: number;
    deploymentReadiness: number;
  };
  findings: Array<{
    severity: "low" | "medium" | "high";
    category: Category;
    title: string;
    evidence: string;
    recommendation: string;
  }>;
  inspectedFiles: string[];
}

interface SnapshotFile {
  path: string;
  content: string;
  truncated: boolean;
}

interface RepoSnapshot {
  tree: string[];
  files: SnapshotFile[];
}

const TaskConfigSchema = z.object({
  repoUrl: z.string().url(),
  instructions: z.string().min(1),
  branch: z.string().min(1).optional(),
  authorName: z.string().optional(),
  authorEmail: z.string().email().optional(),
  maxSteps: z.number().int().positive().optional(),
});

const NamedTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  task: TaskConfigSchema,
});

const JobConfigSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  attempts: z.number().int().positive().optional().default(1),
  concurrency: z.number().int().positive().optional().default(1),
  tasks: z.array(NamedTaskSchema).min(1),
});

const FindingSchema = z.object({
  severity: z.enum(["low", "medium", "high"]),
  category: z.enum(["documentation", "testing", "packaging", "maintainability", "deployment"]),
  title: z.string().min(1),
  evidence: z.string().min(1),
  recommendation: z.string().min(1),
});

const AuditReportSchema = z.object({
  repoUrl: z.string(),
  model: z.string(),
  summary: z.string().min(1),
  scores: z.object({
    documentation: z.number().min(0).max(1),
    testing: z.number().min(0).max(1),
    packaging: z.number().min(0).max(1),
    maintainability: z.number().min(0).max(1),
    deploymentReadiness: z.number().min(0).max(1),
  }),
  findings: z.array(FindingSchema),
  inspectedFiles: z.array(z.string()),
});

const AUDIT_AGENT: AgentTargetConfig = {
  id: "repo-audit",
  name: "Repo Audit Agent",
  kind: "durable_object",
  namespace: "REPO_AUDIT_AGENT",
};

const SNAPSHOT_FILES = [
  "README.md",
  "README.mdx",
  "README.txt",
  "LICENSE",
  "LICENSE.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "wrangler.jsonc",
  "Dockerfile",
  ".github/workflows/ci.yml",
  ".github/workflows/ci.yaml",
];

function responseForZodError(err: z.ZodError): Response {
  return Response.json(
    { success: false, error: "Invalid request", details: err.issues },
    { status: 400 },
  );
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model did not return JSON");
    return JSON.parse(match[1] ?? match[0]);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function scoreFrom(scores: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const raw = scores[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const normalized = raw > 1 && raw <= 10 ? raw / 10 : raw;
    return Math.max(0, Math.min(1, normalized));
  }
  return 0;
}

function severityFrom(value: unknown): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function categoryFrom(value: unknown): Category {
  if (
    value === "documentation" ||
    value === "testing" ||
    value === "packaging" ||
    value === "maintainability" ||
    value === "deployment"
  ) {
    return value;
  }
  if (value === "deploymentReadiness" || value === "deployment_readiness") return "deployment";
  return "maintainability";
}

function parseAuditReport(raw: unknown, task: TaskConfig, model: string): RepoAuditReport {
  const report = asRecord(raw);
  const scores = asRecord(report.scores);
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const inspectedFiles = Array.isArray(report.inspectedFiles)
    ? report.inspectedFiles.filter((file): file is string => typeof file === "string")
    : [];

  const normalized: RepoAuditReport = {
    repoUrl: asString(report.repoUrl, task.repoUrl),
    model: asString(report.model, model),
    summary: asString(report.summary, "Model returned an audit without a summary."),
    scores: {
      documentation: scoreFrom(scores, ["documentation", "docs"]),
      testing: scoreFrom(scores, ["testing", "tests", "testCoverage"]),
      packaging: scoreFrom(scores, ["packaging", "package", "build"]),
      maintainability: scoreFrom(scores, ["maintainability", "maintenance"]),
      deploymentReadiness: scoreFrom(scores, [
        "deploymentReadiness",
        "deployment_readiness",
        "deployment",
        "deploy",
      ]),
    },
    findings: findings.map((finding, index) => {
      const value = asRecord(finding);
      return {
        severity: severityFrom(value.severity),
        category: categoryFrom(value.category),
        title: asString(value.title, `Finding ${index + 1}`),
        evidence: asString(value.evidence, "No specific evidence provided by the model."),
        recommendation: asString(value.recommendation, "Review this area manually."),
      };
    }),
    inspectedFiles,
  };

  return AuditReportSchema.parse(normalized);
}

function auditReward(report: RepoAuditReport, ctx: CriterionContext): Promise<RewardResult> {
  return scoreRun(
    [
      reward({
        name: "repo_audit",
        criteria: [
          criterion({ name: "documentation", evaluate: () => report.scores.documentation }),
          criterion({ name: "testing", evaluate: () => report.scores.testing }),
          criterion({ name: "packaging", evaluate: () => report.scores.packaging }),
          criterion({ name: "maintainability", evaluate: () => report.scores.maintainability }),
          criterion({ name: "deployment_readiness", evaluate: () => report.scores.deploymentReadiness }),
        ],
      }),
    ],
    ctx,
  );
}

async function safeReadFile(workspace: Workspace, path: string): Promise<string | null> {
  try {
    return await workspace.readFile(path);
  } catch {
    return null;
  }
}

async function listTree(workspace: Workspace, dir = "", depth = 0): Promise<string[]> {
  if (depth > 1) return [];
  try {
    const entries = await workspace.readDir(dir || undefined, { limit: 80 });
    const paths: string[] = [];
    for (const entry of entries) {
      const path = entry.path;
      if (path.includes(".git/")) continue;
      paths.push(`${entry.type}:${path}`);
      if (entry.type === "directory" && depth === 0 && !path.startsWith("node_modules")) {
        paths.push(...(await listTree(workspace, path, depth + 1)));
      }
    }
    return paths.slice(0, 160);
  } catch {
    return [];
  }
}

async function collectSnapshot(workspace: Workspace): Promise<RepoSnapshot> {
  const tree = await listTree(workspace);
  const files: SnapshotFile[] = [];
  let totalChars = 0;

  for (const path of SNAPSHOT_FILES) {
    if (files.length >= 12 || totalChars >= 40_000) break;
    const content = await safeReadFile(workspace, path);
    if (content === null) continue;
    const remaining = 40_000 - totalChars;
    const sliced = content.slice(0, Math.min(8_000, remaining));
    totalChars += sliced.length;
    files.push({ path, content: sliced, truncated: sliced.length < content.length });
  }

  return { tree, files };
}

function buildPrompt(task: TaskConfig, snapshot: RepoSnapshot, model: string): string {
  return [
    "You are auditing a repository read-only. Do not propose or perform direct modifications in this run.",
    "Use only the repository snapshot below as evidence. If evidence is missing, say so plainly.",
    "Return strict JSON only. Do not wrap it in markdown.",
    "Scores must be numbers from 0 to 1.",
    "The JSON shape is:",
    JSON.stringify(
      {
        repoUrl: task.repoUrl,
        model,
        summary: "short audit summary",
        scores: {
          documentation: 0.5,
          testing: 0.5,
          packaging: 0.5,
          maintainability: 0.5,
          deploymentReadiness: 0.5,
        },
        findings: [
          {
            severity: "medium",
            category: "testing",
            title: "Finding title",
            evidence: "Specific evidence from inspected files or tree",
            recommendation: "Actionable recommendation",
          },
        ],
        inspectedFiles: ["README.md"],
      },
      null,
      2,
    ),
    "\nUser audit instructions:",
    task.instructions,
    "\nRepository tree:",
    snapshot.tree.join("\n") || "(empty)",
    "\nInspected files:",
    snapshot.files
      .map(
        (file) => `\n--- ${file.path}${file.truncated ? " (truncated)" : ""} ---\n${file.content}`,
      )
      .join("\n"),
  ].join("\n");
}

/**
 * Non-agentic environment for repo audits.
 *
 * Extends FlarborEnvironment for workspace and git infrastructure but uses
 * direct `generateText` calls instead of the multi-turn agent loop.
 */
export class RepoAuditAgent extends FlarborEnvironment<Env> {
  getEnvironmentConfig(): EnvironmentConfig {
    const modelName = this.env.MODEL_NAME || "claude-opus-4-6";
    return {
      model: createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })(modelName),
      systemPrompt: "Repository auditor.",
    };
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/run" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    let task: TaskConfig;
    try {
      task = TaskConfigSchema.parse(await request.json());
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return responseForZodError(err);
      throw err;
    }

    const result = await this.runAuditSafely(task);
    return Response.json(result, { status: result.success ? 200 : 500 });
  }

  private async runAuditSafely(task: TaskConfig): Promise<TrialResult> {
    try {
      return await this.runAudit(task);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[repo-audit] failed repo=${task.repoUrl} error=${message}`);

      const errorReport: RepoAuditReport = {
        repoUrl: task.repoUrl,
        model: "error",
        summary: message,
        scores: { documentation: 0, testing: 0, packaging: 0, maintainability: 0, deploymentReadiness: 0 },
        findings: [],
        inspectedFiles: [],
      };
      const errorCtx: CriterionContext = {
        workspace: this.workspace,
        filesChanged: [],
        success: false,
        error: message,
      };
      const rewardResult = await auditReward(errorReport, errorCtx);

      return {
        success: false,
        branch: "",
        commitSha: "",
        filesChanged: [],
        error: message,
        reward: rewardResult,
        metadata: { auditError: message },
      };
    }
  }

  private async runAudit(task: TaskConfig): Promise<TrialResult> {
    if (!this.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is required. Copy .dev.vars.example to .dev.vars and set it.",
      );
    }

    const modelName = this.env.MODEL_NAME || "claude-opus-4-6";
    const model = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })(modelName);
    const startedAt = Date.now();

    await this.gitWorkspace.clone(task.repoUrl);
    const snapshot = await collectSnapshot(this.workspace);
    const prompt = buildPrompt(task, snapshot, modelName);
    const generated = await generateText({ model, prompt });
    const report = parseAuditReport(extractJson(generated.text), task, modelName);
    const usage = {
      inputTokens: generated.usage?.inputTokens ?? 0,
      outputTokens: generated.usage?.outputTokens ?? 0,
      totalTokens: generated.usage?.totalTokens ?? 0,
    };

    const auditCtx: CriterionContext = {
      workspace: this.workspace,
      filesChanged: [],
      success: true,
      usage,
    };
    const rewardResult = await auditReward(report, auditCtx);

    console.log(
      `[repo-audit] complete repo=${task.repoUrl} score=${rewardResult.score.toFixed(3)} duration=${Date.now() - startedAt}ms`,
    );

    return {
      success: true,
      branch: "",
      commitSha: "",
      filesChanged: [],
      usage,
      reward: rewardResult,
      metadata: { audit: report },
    };
  }
}

export class RepoAuditJob extends JobObject<Env> {
  protected resolveAgent(_target: AgentTargetConfig, trial: TrialConfig): FetcherLike {
    return this.env.REPO_AUDIT_AGENT.getByName(
      `${trial.task.repoUrl}:${trial.id}:${crypto.randomUUID()}`,
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run" && request.method === "POST") {
      const body = await request
        .clone()
        .json()
        .catch(() => undefined);
      let task: TaskConfig;
      try {
        task = TaskConfigSchema.parse(body);
      } catch (err: unknown) {
        if (err instanceof z.ZodError) return responseForZodError(err);
        throw err;
      }
      const stub = env.REPO_AUDIT_AGENT.getByName(`${task.repoUrl}:single:${crypto.randomUUID()}`);
      const response = await stub.fetch(request);
      return new Response(response.body, response);
    }

    if (url.pathname === "/jobs/run" && request.method === "POST") {
      let config: JobConfig;
      try {
        const body = JobConfigSchema.parse(await request.json());
        config = { ...body, agents: [AUDIT_AGENT] };
      } catch (err: unknown) {
        if (err instanceof z.ZodError) return responseForZodError(err);
        throw err;
      }

      const result = await runJob(config, {
        resolveAgent: (_target, trial) =>
          env.REPO_AUDIT_AGENT.getByName(
            `${trial.task.repoUrl}:${trial.id}:${crypto.randomUUID()}`,
          ),
      });
      return Response.json(result, { status: result.status === "completed" ? 200 : 500 });
    }

    if (url.pathname === "/jobs" && request.method === "POST") {
      let config: JobConfig;
      try {
        const body = JobConfigSchema.parse(await request.json());
        config = { ...body, agents: [AUDIT_AGENT] };
      } catch (err: unknown) {
        if (err instanceof z.ZodError) return responseForZodError(err);
        throw err;
      }

      const id = createJobId(config);
      const stub = env.REPO_AUDIT_JOB.getByName(id);
      const result: JobResult = await stub.start(config);
      return Response.json(result, { status: result.status === "completed" ? 200 : 500 });
    }

    const cancelMatch = url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method === "POST") {
      const id = decodeURIComponent(cancelMatch[1]);
      const stub = env.REPO_AUDIT_JOB.getByName(id);
      const result: JobResult = await stub.cancel();
      return Response.json(result);
    }

    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (jobMatch && request.method === "GET") {
      const id = decodeURIComponent(jobMatch[1]);
      const stub = env.REPO_AUDIT_JOB.getByName(id);
      const result: JobResult | undefined = await stub.get();
      if (!result)
        return Response.json({ success: false, error: "Job not found" }, { status: 404 });
      return Response.json(result);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
