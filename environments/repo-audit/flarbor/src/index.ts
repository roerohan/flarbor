import { createAnthropic } from "@ai-sdk/anthropic";
import { DurableObject } from "cloudflare:workers";
import { generateText } from "ai";
import { Workspace } from "@cloudflare/think";
import { z } from "zod";
import { GitWorkspace } from "flarbor";
import type { RewardResult, TaskConfig, TrialResult } from "flarbor";
import { runJob } from "flarbor-job";
import type { AgentTargetConfig, JobConfig } from "flarbor-job";

interface Env {
  REPO_AUDIT_AGENT: DurableObjectNamespace<RepoAuditAgent>;
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

function auditReward(report: RepoAuditReport): RewardResult {
  const criteria = [
    { name: "documentation", score: report.scores.documentation, weight: 1 },
    { name: "testing", score: report.scores.testing, weight: 1 },
    { name: "packaging", score: report.scores.packaging, weight: 1 },
    { name: "maintainability", score: report.scores.maintainability, weight: 1 },
    { name: "deployment_readiness", score: report.scores.deploymentReadiness, weight: 1 },
  ];
  const score = criteria.reduce((sum, criterion) => sum + criterion.score, 0) / criteria.length;
  return {
    score,
    totalCriteria: criteria.length,
    errors: 0,
    rewards: [{ name: "repo_audit", score, criteria, aggregation: "weighted_mean" }],
  };
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

export class RepoAuditAgent extends DurableObject<Env> {
  private workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.ctx.id.toString(),
  });

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/run" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    try {
      const task = TaskConfigSchema.parse(await request.json());
      const result = await this.runAudit(task);
      return Response.json(result, { status: result.success ? 200 : 500 });
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return responseForZodError(err);
      const message = err instanceof Error ? err.message : String(err);
      return Response.json(
        { success: false, branch: "", commitSha: "", filesChanged: [], error: message },
        { status: 500 },
      );
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

    const gitWorkspace = new GitWorkspace(this.workspace);
    await gitWorkspace.clone(task.repoUrl);
    const snapshot = await collectSnapshot(this.workspace);
    const prompt = buildPrompt(task, snapshot, modelName);
    const generated = await generateText({ model, prompt });
    const report = AuditReportSchema.parse(extractJson(generated.text));
    const usage = {
      inputTokens: generated.usage?.inputTokens ?? 0,
      outputTokens: generated.usage?.outputTokens ?? 0,
      totalTokens: generated.usage?.totalTokens ?? 0,
    };

    console.log(
      `[repo-audit] complete repo=${task.repoUrl} score=${auditReward(report).score.toFixed(3)} duration=${Date.now() - startedAt}ms`,
    );

    return {
      success: true,
      branch: "",
      commitSha: "",
      filesChanged: [],
      usage,
      reward: auditReward(report),
      metadata: { audit: report },
    };
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
          env.REPO_AUDIT_AGENT.getByName(`${trial.task.repoUrl}:${trial.id}:${crypto.randomUUID()}`),
      });
      return Response.json(result, { status: result.status === "completed" ? 200 : 500 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
