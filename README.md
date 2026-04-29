# Flarbor

[Harbor](https://www.harborframework.com/docs) alternative built entirely on Cloudflare primitives.

Where Harbor relies on Docker containers for durable execution and isolated environments, Flarbor replaces them with Durable Objects, Dynamic Workers, and the Cloudflare Agents SDK — achieving the same isolation and persistence model without containers for the core workflow.

Containers are only needed when running `npm build`, `npm test`, or other OS-level toolchains, and for that Flarbor defers to the [Sandbox SDK](https://developers.cloudflare.com/sandbox/).

## Why

RL environments will be democratized. People will train their own bespoke models for their specific use case — not fine-tune a generic foundation model, but run task-specific RL loops with reward functions tailored to their domain.

The bottleneck is environment infrastructure. Harbor proved the concept with Docker containers, but containers are heavy, slow to cold-start, and expensive at scale. The core agentic workflow — clone a repo, read files, make changes, push — doesn't need an OS. It needs a filesystem, git, and an LLM.

Flarbor runs that workflow on Cloudflare's execution ladder: Durable Objects for state, Workspaces for filesystems, Dynamic Workers for sandboxed code execution, and isomorphic-git for version control. No containers, no VMs, no cold starts. A thousand idle environments cost nothing.

When you *do* need a real OS — for `npm test`, compilers, build toolchains — Flarbor spins up a container on demand via the Sandbox SDK. Containers as a last resort, not the default.

## Quick start

```bash
pnpm install

# Set secrets
wrangler secret put ANTHROPIC_API_KEY --name code-change-flarbor
wrangler secret put GITHUB_TOKEN --name code-change-flarbor

# Run locally
pnpm dev

# Or deploy
pnpm deploy
```

Trigger a code change:

```bash
curl -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/org/repo",
    "instructions": "Add error handling to the fetch calls in src/api.ts",
    "branch": "flarbor/add-error-handling"
  }'
```

You can also set defaults via wrangler env vars (`REPO_URL`, `INSTRUCTION`, `BRANCH`, etc.) and send a minimal or empty POST body — request fields override env var defaults.

## Repository structure

```
flarbor/
├── packages/
│   ├── flarbor/              Core library (FlarborEnvironment, GitWorkspace, runTask)
│   └── flarbor-reward/       Reward/scoring kit for evaluating agent outputs
└── environments/
    └── code-change/
        ├── flarbor/          Cloudflare Workers + Durable Objects implementation
        └── harbor/           Docker container implementation (for comparison)
```

### `packages/flarbor`

The core library. Exports `FlarborEnvironment`, an abstract base class extending `@cloudflare/think` that handles everything infrastructure: lifecycle hooks, token tracking, error capture, chat recovery, git workspace, and code execution wiring.

Environments subclass it and implement `getEnvironmentConfig()` with their domain-specific model, prompt, tools, and safety rules. Typically under 50 lines.

### `packages/flarbor-reward`

Composable reward/scoring kit. Define criteria (file checks, diff analysis, token budgets, LLM-as-judge), group them into rewards with aggregation strategies, and score trials.

```typescript
import { run, reward, fileExists, trialSuccess, tokenBudget } from "flarbor-reward";

const result = await run(
  [
    reward({ name: "correctness", criteria: [fileExists("output.txt"), trialSuccess(3.0)] }),
    reward({ name: "efficiency", criteria: [tokenBudget(50_000)] }),
  ],
  { workspace, filesChanged, success: true, usage },
);
```

### `environments/code-change/`

Side-by-side Flarbor and Harbor implementations of the same task: clone a repo, make LLM-driven changes, commit and push. Use both to benchmark.

## Concept mapping

| Harbor | Flarbor | Cloudflare primitive |
|---|---|---|
| `BaseEnvironment` (Docker container) | `FlarborEnvironment` (Durable Object) | [Durable Objects](https://developers.cloudflare.com/durable-objects/) + [`@cloudflare/shell`](https://www.npmjs.com/package/@cloudflare/shell) |
| `BaseAgent` | Think subclass | [`@cloudflare/think`](https://developers.cloudflare.com/agents/api-reference/think/) |
| Task (instruction + test) | `TaskConfig` via `POST /run` | Think chat turn |
| Trial (one attempt) | `runTask()` -> `TrialResult` | DO instance lifecycle |
| Container filesystem | `GitWorkspace` (Workspace + isomorphic-git) | [`Workspace`](https://www.npmjs.com/package/@cloudflare/shell) |
| `docker exec` | `@cloudflare/shell` state API | Dynamic Workers |
| `git` CLI | `@cloudflare/shell/git` | Pure-JS git |
| `npm test` / `npm build` | Sandbox SDK | [`@cloudflare/sandbox`](https://developers.cloudflare.com/sandbox/) |

## Execution ladder

| Tier | What | Container? |
|---|---|---|
| 0: Workspace | Durable virtual filesystem (SQLite + R2) | No |
| 1: Dynamic Worker | Sandboxed V8 isolate, no network | No |
| 2: Dynamic Worker + npm | Isolate with bundled packages | No |
| 3: Browser | Headless Chrome via Browser Run | No |
| 4: Sandbox | Full Linux container | Yes |

Tiers 0-2 handle the core workflow. Tier 4 is only for build/test.

## Comparing Flarbor vs Harbor

Both environments in `environments/code-change/` do the same thing, so you can benchmark directly.

### Running both

```bash
# Flarbor
pnpm dev
time curl -s -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -d '{"repoUrl":"https://github.com/org/repo","instructions":"..."}' | jq .

# Harbor
cd environments/code-change/harbor
export REPO_URL="https://github.com/org/repo"
export INSTRUCTION="..."
export GITHUB_TOKEN="ghp_..."
export ANTHROPIC_API_KEY="sk-ant-..."
time ./run.sh
```

### Cost comparison

Both use the same model (`claude-opus-4-6` via Anthropic API directly), so LLM costs are identical.

**Flarbor (Cloudflare)**:
- DO compute: $12.50/M requests + $0.10/GB-s wall-clock
- DO storage: $0.20/M reads, $1.00/M writes, $0.75/GB stored
- Idle cost: **$0** (DOs hibernate)

**Harbor (Docker)**:
- Local Docker: free (your machine)
- Cloud sandboxes: per-second billing (Daytona, Modal, E2B)
- Idle cost: $0 locally, per-second on cloud

### What to measure

| Metric | How |
|---|---|
| Wall-clock latency | `time curl` / `time ./run.sh` |
| Token usage | `usage` field in result JSON |
| Cold start | First request after deploy (Flarbor ~50-200ms; Harbor 10-60s) |
| Files changed | `filesChanged` in result |
| Success rate | Run N trials, compare `success` rate |

Run 3-5 trials per side with the same repo and instruction. LLM output is non-deterministic.

## Roadmap

- [x] Core library (`FlarborEnvironment`, `GitWorkspace`, task runner)
- [x] Reward/scoring kit (`flarbor-reward`)
- [x] Code-change environment with Harbor comparison
- [ ] End-to-end validation on deployed Workers
- [ ] `flarbor-sandbox` — Sandbox SDK integration for build/test
- [ ] Eval runner environment (run task datasets, collect results)
- [ ] Job orchestration via DO sub-agents (Facets)
- [ ] Task/dataset registry

## License

Apache-2.0
