# code-change-agent-harbor

Harbor equivalent of the Flarbor `code-change-agent`. Both environments do the
same thing — clone a repo, make LLM-driven code changes, commit, and push — so
you can compare latency and cost between the two platforms.

## Prerequisites

### Flarbor environment

```bash
# From repo root
pnpm install

# Set your secrets via Wrangler
wrangler secret put ANTHROPIC_API_KEY --name code-change-agent
wrangler secret put GITHUB_TOKEN --name code-change-agent
```

### Harbor environment

```bash
# Install Harbor and LiteLLM
uv tool install harbor
pip install litellm

# Or with pip:
pip install harbor litellm

# Install the agent package (from this directory)
pip install -e .

# Docker must be running (Harbor uses it for the container environment)
```

## Running

### Flarbor (Cloudflare Workers + Durable Objects)

```bash
# Option A: deploy to Cloudflare and hit the remote endpoint
pnpm --filter code-change-agent run deploy

curl -X POST https://<your-worker>.workers.dev/run \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/org/repo",
    "instructions": "Add error handling to the fetch calls in src/api.ts",
    "branch": "flarbor/add-error-handling"
  }'

# Option B: run locally via wrangler dev
pnpm --filter code-change-agent run dev

curl -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/org/repo",
    "instructions": "Add error handling to the fetch calls in src/api.ts",
    "branch": "flarbor/add-error-handling"
  }'
```

### Harbor (Docker container)

```bash
export REPO_URL="https://github.com/org/repo"
export GITHUB_TOKEN="ghp_..."
export ANTHROPIC_API_KEY="sk-ant-..."
export INSTRUCTION="Add error handling to the fetch calls in src/api.ts"
export BRANCH="harbor/add-error-handling"

# Option A: use the convenience script
./run.sh

# Option B: use harbor CLI directly
harbor run \
  -p environments/code-change-agent-harbor/task \
  --agent-import-path code_change_agent.agent:CodeChangeAgent \
  -m "anthropic/claude-opus-4-6" \
  --env docker
```

## Comparing costs

Both environments track token usage. To make a fair comparison, run both against
the same repo and instruction, then compare the outputs.

### Where to find token usage

| | Flarbor | Harbor |
|---|---|---|
| **Response location** | JSON body of `POST /run` response | `trials/<trial>/logs/agent/trial_result.json` |
| **Fields** | `usage.inputTokens`, `usage.outputTokens`, `usage.totalTokens` | `usage.inputTokens`, `usage.outputTokens`, `usage.totalTokens` |
| **How tracked** | Think's `onStepFinish` accumulates AI SDK usage per step | LiteLLM's `response.usage.prompt_tokens` / `completion_tokens` per call |

### LLM inference cost

Both use the same model (`claude-opus-4-6`) calling the Anthropic API
directly. The LLM cost per token is identical on both sides:

| Provider | Used by | Pricing |
|---|---|---|
| **Anthropic API** (via `@ai-sdk/anthropic`) | Flarbor | [Anthropic pricing](https://www.anthropic.com/pricing) — $3/M input, $15/M output |
| **Anthropic API** (via LiteLLM) | Harbor | [Anthropic pricing](https://www.anthropic.com/pricing) — $3/M input, $15/M output |

To calculate LLM cost from a trial result:

```
llm_cost = (inputTokens * input_price_per_token) + (outputTokens * output_price_per_token)
```

### Compute / infrastructure cost

This is where the two platforms diverge.

**Flarbor (Cloudflare):**

| Resource | Pricing |
|---|---|
| Durable Object compute | [$12.50/M requests + $0.10/GB-s wall-clock duration](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Durable Object storage (SQLite) | [$0.20/M reads, $1.00/M writes, $0.75/GB stored](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Worker invocation | [$0.30/M requests (first 10M free)](https://developers.cloudflare.com/workers/platform/pricing/) |
| Dynamic Worker (code execution) | Included in DO compute |
| Anthropic API (LLM) | [Per-token](https://www.anthropic.com/pricing) — same cost as Harbor |
| **Idle cost** | **$0** — DOs hibernate when unused |

**Harbor (Docker):**

| Resource | Pricing |
|---|---|
| Local Docker | Free (your machine's CPU/memory) |
| Cloud sandbox (Daytona) | [Per-workspace-minute](https://www.daytona.io/pricing) |
| Cloud sandbox (Modal) | [$0.192/hr/CPU + memory](https://modal.com/pricing) |
| Cloud sandbox (E2B) | [Per-sandbox-second](https://e2b.dev/pricing) |
| Anthropic API (LLM) | [Per-token](https://www.anthropic.com/pricing) — same cost as Flarbor |
| **Idle cost** | **$0** locally, per-second if using cloud sandboxes |

### Running a comparison

```bash
# 1. Pick a repo and instruction
REPO="https://github.com/org/repo"
INSTRUCTION="Add error handling to the fetch calls in src/api.ts"

# 2. Run Flarbor (measures wall-clock time via curl)
time curl -s -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -d "{
    \"repoUrl\": \"$REPO\",
    \"instructions\": \"$INSTRUCTION\",
    \"branch\": \"flarbor/test-run\"
  }" | jq .

# 3. Run Harbor (measures wall-clock time via the run script)
export REPO_URL="$REPO"
export GITHUB_TOKEN="ghp_..."
export INSTRUCTION="$INSTRUCTION"
export BRANCH="harbor/test-run"
time ./run.sh

# 4. Compare
# - Wall-clock time: printed by `time` and the run script
# - Token usage: Flarbor prints in the curl response JSON;
#   Harbor writes to trials/<trial>/logs/agent/trial_result.json
# - Compute cost: see the pricing tables above
```

### What to measure

| Metric | How to measure | Notes |
|---|---|---|
| **Wall-clock latency** | `time curl ...` / `time ./run.sh` | Includes cold start, clone, LLM turns, push |
| **LLM tokens** | `usage.inputTokens` + `usage.outputTokens` from result JSON | Should be similar if same model + same prompt |
| **LLM cost** | tokens x per-token rate | Same provider (Anthropic) on both sides |
| **Compute cost** | See pricing tables | Flarbor: DO duration; Harbor: container runtime |
| **Cold start** | First request after deploy (Flarbor) / Docker build (Harbor) | Flarbor: ~50-200ms DO startup; Harbor: 10-60s container build+start |
| **Files changed** | `filesChanged` in result JSON | Should be identical for the same task |
| **Success rate** | `success` field | Run N trials and compare pass rates |

### Apples-to-apples tips

- Use the **same model** on both sides. The default is `claude-opus-4-6`
  via direct Anthropic API (both Flarbor and Harbor).
- Use the **same instruction** and **same repo** for each pair of runs.
- Run **multiple trials** (3-5) per side and take the median. LLM output is
  non-deterministic, so a single run is not statistically meaningful.
- Measure **warm** latency (second request) separately from **cold** latency
  (first request after deploy/build) since cold starts are one-time costs.
- If comparing cloud costs, use Harbor's `--env daytona` to get a cloud-hosted
  container that is more comparable to Flarbor's edge-hosted DOs.

## Architecture comparison

| | Flarbor | Harbor |
|---|---|---|
| **Runtime** | Cloudflare Durable Object | Docker container |
| **Agent harness** | `@cloudflare/think` (built-in agentic loop) | Custom tool-calling loop over LiteLLM |
| **File operations** | Workspace tools (read/write/edit/find/grep/list/delete) — in-process, no shell | Shell commands via `environment.exec()` (cat, base64, find, grep, ls, rm) |
| **Git** | `@cloudflare/shell/git` (isomorphic-git, pure JS) | `git` CLI binary in the container |
| **Code execution** | Dynamic Worker (sandboxed V8 isolate) | `execute_command` tool (bash in the container) |
| **Session memory** | Think session context blocks (`plan`, `memory`) with compaction | Full message history (no compaction) |
| **Crash recovery** | Think's `chatRecovery` / `runFiber()` | None — trial fails if process dies |
| **Protected paths** | `beforeToolCall` hook with glob matching | `_matches_protected_path()` with `fnmatch` |
| **Scaling** | Automatic — DOs scale to zero, spin up on demand | Manual — Docker locally, or cloud sandboxes for parallelism |
