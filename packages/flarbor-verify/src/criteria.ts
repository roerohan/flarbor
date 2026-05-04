import { createVerifyError, throwVerifyError, VerifyFailure } from "./errors.js";
import { requireExec } from "./capabilities.js";
import type { CriterionDetail, VerifyContext, VerifyCriterion, VerifyOutput } from "./types.js";

type ExpectedValue = string | number | boolean | null;

interface CommandOptions {
  name?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

interface HttpOptions {
  name?: string;
  url: string;
  init?: RequestInit;
}

export function commandSucceeds(options: CommandOptions): VerifyCriterion {
  return execCriterion(options.name ?? "command_succeeds", async (ctx) => {
    const result = await requireExec(ctx.capabilities).run(options);
    return detail(options.name ?? "command_succeeds", result.exitCode === 0 ? 1 : 0, {
      raw: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  });
}

export function commandOutputContains(options: CommandOptions & { text: string }): VerifyCriterion {
  return execCriterion(options.name ?? "command_output_contains", async (ctx) => {
    const result = await requireExec(ctx.capabilities).run(options);
    const output = `${result.stdout}\n${result.stderr}`;
    return detail(
      options.name ?? "command_output_contains",
      output.includes(options.text) ? 1 : 0,
      {
        raw: output,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    );
  });
}

export function commandOutputMatches(options: CommandOptions & { text: string }): VerifyCriterion {
  return execCriterion(options.name ?? "command_output_matches", async (ctx) => {
    const result = await requireExec(ctx.capabilities).run(options);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return detail(options.name ?? "command_output_matches", output === options.text ? 1 : 0, {
      raw: output,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  });
}

export function commandOutputMatchesRegex(
  options: CommandOptions & { pattern: string; flags?: string },
): VerifyCriterion {
  return execCriterion(options.name ?? "command_output_matches_regex", async (ctx) => {
    const result = await requireExec(ctx.capabilities).run(options);
    const output = `${result.stdout}\n${result.stderr}`;
    const regex = new RegExp(options.pattern, options.flags);
    return detail(options.name ?? "command_output_matches_regex", regex.test(output) ? 1 : 0, {
      raw: output,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  });
}

export function httpStatusEquals(options: HttpOptions & { status: number }): VerifyCriterion {
  return pureCriterion(options.name ?? "http_status_equals", async (ctx) => {
    const response = await getHttpResponse(ctx, options);
    return detail(
      options.name ?? "http_status_equals",
      response.status === options.status ? 1 : 0,
      {
        raw: response.status,
        stdout: response.stdout,
        stderr: response.stderr,
      },
    );
  });
}

export function httpResponseContains(options: HttpOptions & { text: string }): VerifyCriterion {
  return pureCriterion(options.name ?? "http_response_contains", async (ctx) => {
    const response = await getHttpResponse(ctx, options);
    const body = response.body;
    return detail(options.name ?? "http_response_contains", body.includes(options.text) ? 1 : 0, {
      raw: body,
      stdout: response.stdout,
      stderr: response.stderr,
    });
  });
}

export function fileExists(options: { name?: string; path: string }): VerifyCriterion {
  return pureCriterion(options.name ?? "file_exists", async (ctx) => {
    const file = await ctx.workspace.readFile(options.path);
    return detail(options.name ?? "file_exists", file === null ? 0 : 1, { raw: file !== null });
  });
}

export function fileContains(options: {
  name?: string;
  path: string;
  text: string;
}): VerifyCriterion {
  return pureCriterion(options.name ?? "file_contains", async (ctx) => {
    const file = await ctx.workspace.readFile(options.path);
    return detail(options.name ?? "file_contains", file?.includes(options.text) ? 1 : 0, {
      raw: file,
    });
  });
}

export function fileMatches(options: {
  name?: string;
  path: string;
  pattern: string;
  flags?: string;
}): VerifyCriterion {
  return pureCriterion(options.name ?? "file_matches", async (ctx) => {
    const file = await ctx.workspace.readFile(options.path);
    const matches = file === null ? false : new RegExp(options.pattern, options.flags).test(file);
    return detail(options.name ?? "file_matches", matches ? 1 : 0, { raw: file });
  });
}

export function jsonKeyEquals(options: {
  name?: string;
  path: string;
  key: string;
  expected: ExpectedValue;
}): VerifyCriterion {
  return pureCriterion(options.name ?? "json_key_equals", async (ctx) => {
    const value = await readJson(ctx, options.path);
    const actual = isRecord(value) ? value[options.key] : undefined;
    return detail(options.name ?? "json_key_equals", sameValue(actual, options.expected) ? 1 : 0, {
      raw: actual,
    });
  });
}

export function jsonPathEquals(options: {
  name?: string;
  path: string;
  jsonPath: string;
  expected: ExpectedValue;
}): VerifyCriterion {
  return pureCriterion(options.name ?? "json_path_equals", async (ctx) => {
    const value = await readJson(ctx, options.path);
    const actual = getJsonPath(value, options.jsonPath);
    return detail(options.name ?? "json_path_equals", sameValue(actual, options.expected) ? 1 : 0, {
      raw: actual,
    });
  });
}

export function csvCellEquals(options: {
  name?: string;
  path: string;
  row: number;
  column: number | string;
  expected: string;
}): VerifyCriterion {
  return pureCriterion(options.name ?? "csv_cell_equals", async (ctx) => {
    const file = await ctx.workspace.readFile(options.path);
    const rows = parseCsv(file ?? "");
    const row = rows[options.row];
    const columnIndex =
      typeof options.column === "number" ? options.column : rows[0]?.indexOf(options.column);
    const actual = columnIndex === undefined || columnIndex < 0 ? undefined : row?.[columnIndex];
    return detail(options.name ?? "csv_cell_equals", actual === options.expected ? 1 : 0, {
      raw: actual,
    });
  });
}

export function sqliteQueryEquals(options: {
  name?: string;
  database: string;
  query: string;
  expected: string;
}): VerifyCriterion {
  const name = options.name ?? "sqlite_query_equals";
  return execCriterion(name, async (ctx) => {
    const command = `sqlite3 -noheader -batch ${shellArg(options.database)} ${shellArg(options.query)}`;
    const result = await requireExec(ctx.capabilities).run({ command });
    const actual = result.stdout.trim();
    return detail(name, actual === options.expected ? 1 : 0, {
      raw: actual,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  });
}

export function imageSizeEquals(options: {
  name?: string;
  path: string;
  width: number;
  height: number;
}): VerifyCriterion {
  const name = options.name ?? "image_size_equals";
  return execCriterion(name, async (ctx) => {
    const command = `python3 - <<'PY'\nfrom PIL import Image\nimg=Image.open(${pythonString(options.path)})\nprint(f'{img.size[0]}x{img.size[1]}')\nPY`;
    const result = await requireExec(ctx.capabilities).run({ command });
    const actual = result.stdout.trim();
    return detail(name, actual === `${options.width}x${options.height}` ? 1 : 0, {
      raw: actual,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  });
}

export function imageSimilarity(options: {
  name?: string;
  actual: string;
  expected: string;
  minSimilarity: number;
}): VerifyCriterion {
  const name = options.name ?? "image_similarity";
  return execCriterion(name, async (ctx) => {
    const command = `python3 - <<'PY'\nfrom PIL import Image, ImageChops\na=Image.open(${pythonString(options.actual)}).convert('RGB')\ne=Image.open(${pythonString(options.expected)}).convert('RGB')\nif a.size != e.size:\n print(0)\nelse:\n diff=ImageChops.difference(a,e)\n extrema=diff.getextrema()\n maxdiff=sum(max(v) for v in extrema)/(255*3)\n print(1-maxdiff)\nPY`;
    const result = await requireExec(ctx.capabilities).run({ command });
    const similarity = Number(result.stdout.trim());
    return detail(
      name,
      Number.isFinite(similarity) && similarity >= options.minSimilarity ? 1 : 0,
      {
        raw: similarity,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    );
  });
}

export function xlsxCellEquals(options: {
  name?: string;
  path: string;
  cell: string;
  expected: string;
  sheet?: string;
}): VerifyCriterion {
  const name = options.name ?? "xlsx_cell_equals";
  return execCriterion(name, async (ctx) => {
    const sheet = options.sheet ? `ws=wb[${pythonString(options.sheet)}]` : "ws=wb.active";
    const command = `python3 - <<'PY'\nfrom openpyxl import load_workbook\nwb=load_workbook(${pythonString(options.path)}, data_only=True)\n${sheet}\nvalue=ws[${pythonString(options.cell)}].value\nprint('' if value is None else value)\nPY`;
    const result = await requireExec(ctx.capabilities).run({ command });
    const actual = result.stdout.trim();
    return detail(name, actual === options.expected ? 1 : 0, {
      raw: actual,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  });
}

export async function runVerifyCriteria(
  criteria: readonly VerifyCriterion[],
  ctx: VerifyContext,
): Promise<VerifyOutput> {
  const details: CriterionDetail[] = [];
  const scores: Record<string, number> = {};
  for (const criterion of criteria) {
    try {
      const result = await criterion.evaluate(ctx);
      details.push(result);
      scores[result.name] = result.score;
    } catch (error) {
      const verifyError = errorToVerifyError(error);
      details.push({ name: criterion.name, score: 0, error: verifyError });
      scores[criterion.name] = 0;
    }
  }
  return { rewards: scores, details };
}

function pureCriterion(
  name: string,
  evaluate: (ctx: VerifyContext) => Promise<CriterionDetail>,
): VerifyCriterion {
  return { name, requiresExec: false, evaluate };
}

function execCriterion(
  name: string,
  evaluate: (ctx: VerifyContext) => Promise<CriterionDetail>,
): VerifyCriterion {
  return { name, requiresExec: true, evaluate };
}

function detail(
  name: string,
  score: number,
  extras: { raw?: unknown; stdout?: string; stderr?: string } = {},
): CriterionDetail {
  return { name, score: Math.max(0, Math.min(1, score)), ...extras };
}

async function getHttpResponse(
  ctx: VerifyContext,
  options: HttpOptions,
): Promise<{ status: number; body: string; stdout?: string; stderr?: string }> {
  if (isLocalhostUrl(options.url) && ctx.capabilities.exec) {
    const result = await ctx.capabilities.exec.run({
      command: `curl -sS -L -w '\n__FLARBOR_STATUS__:%{http_code}' ${shellArg(options.url)}`,
    });
    const marker = "\n__FLARBOR_STATUS__:";
    const markerIndex = result.stdout.lastIndexOf(marker);
    if (markerIndex < 0) {
      return { status: 0, body: result.stdout, stdout: result.stdout, stderr: result.stderr };
    }
    const body = result.stdout.slice(0, markerIndex);
    const status = Number(result.stdout.slice(markerIndex + marker.length).trim());
    return {
      status: Number.isFinite(status) ? status : 0,
      body,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  const fetcher = ctx.capabilities.fetch;
  if (!fetcher) {
    throwVerifyError(
      "EXEC_UNAVAILABLE",
      "HTTP verifier criteria require a fetch capability or an exec capability for localhost URLs.",
    );
  }
  const response = await fetcher(options.url, options.init);
  return { status: response.status, body: await response.text() };
}

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

async function readJson(ctx: VerifyContext, path: string): Promise<unknown> {
  const file = await ctx.workspace.readFile(path);
  if (file === null) return undefined;
  return JSON.parse(file);
}

function sameValue(actual: unknown, expected: ExpectedValue): boolean {
  return actual === expected;
}

function getJsonPath(value: unknown, path: string): unknown {
  const parts = path.replaceAll("[", ".").replaceAll("]", "").split(".").filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

function errorToVerifyError(error: unknown) {
  if (error instanceof VerifyFailure) return error.error;
  if (isVerifyErrorLike(error)) return error;
  if (error instanceof Error) return createVerifyError("VERIFIER_FAILED", error.message);
  return createVerifyError("VERIFIER_FAILED", "Verifier criterion failed.", error);
}

function isVerifyErrorLike(error: unknown): error is ReturnType<typeof createVerifyError> {
  return isRecord(error) && typeof error.code === "string" && typeof error.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function pythonString(value: string): string {
  return JSON.stringify(value);
}
