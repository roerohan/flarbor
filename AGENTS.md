# Flarbor

Harbor alternative built on Cloudflare primitives. See [README.md](./README.md) for vision and usage.

## Repository structure

```
flarbor/
├── packages/
│   ├── flarbor-shared/            Shared types, utilities, and test helpers
│   │   └── src/
│   │       ├── index.ts           Public API re-exports
│   │       ├── types.ts           TokenUsage, CriterionContext, RewardResult, WorkspaceLike, etc.
│   │       ├── glob.ts            Canonical glob-to-regex (supports *, **, ?)
│   │       ├── budget-decay.ts    budgetDecay() — shared scoring curve
│   │       ├── dispatch.ts        dispatchTask(), DispatchError — agent dispatch
│   │       ├── trial-result.ts    isTrialResult() runtime type guard
│   │       └── testing.ts         mockWorkspace(), mockContext() test helpers
│   ├── flarbor/                   Core library
│   │   └── src/
│   │       ├── index.ts           Public API re-exports
│   │       ├── environment.ts     FlarborEnvironment — abstract Think subclass
│   │       ├── workspace.ts       GitWorkspace (Workspace + isomorphic-git)
│   │       ├── agent-runner.ts    runTask() — never-throw wrapper around dispatchTask
│   │       └── types.ts           TaskConfig, TrialResult, EnvironmentConfig, FlarborEnv
│   ├── flarbor-job/               Batch job orchestration
│   │   └── src/
│   │       ├── job.ts             runJob(), createTrialConfigs(), PersistenceHook
│   │       ├── object.ts          JobObject — delegates to runJob with persistence
│   │       ├── helpers.ts         agentById(), jobStatus(), terminal()
│   │       ├── queue.ts           runQueue() — bounded concurrency
│   │       ├── trial.ts           runTrial() — single trial orchestration
│   │       ├── retry.ts           withRetry(), exponential backoff
│   │       ├── stats.ts           computeStats(), computeGroupStats()
│   │       ├── hooks.ts           Event, Hook, emit()
│   │       └── types.ts           JobConfig, TrialRecord, JobResult, etc.
│   ├── flarbor-reward/            Reward/scoring kit
│   │   └── src/
│   │       ├── index.ts           Public API re-exports
│   │       ├── types.ts           Criterion, Reward, JudgeConfig (re-exports CriterionContext from shared)
│   │       ├── criterion.ts       criterion() builder
│   │       ├── reward.ts          reward() builder + aggregation
│   │       ├── runner.ts          run() — main scoring entry point
│   │       ├── judge.ts           LLM-as-judge criterion
│   │       └── criteria/
│   │           ├── file.ts        fileExists, fileContains, fileMatches, diffRatio
│   │           ├── diff.ts        hasChanges, diffSize, diffTouchesOnly, noDeletions
│   │           ├── token.ts       tokenBudget, tokenEfficiency, trialSuccess
│   │           └── trajectory.ts  stepBudget, touchedFile, didNotTouch, minFilesChanged
│   └── flarbor-container/         Container offload helpers (Cloudflare Sandbox)
│       └── src/
│           ├── runner.ts          ContainerRunner — sandbox lifecycle
│           ├── tool.ts            AI SDK container command tool
│           ├── workspace-sync.ts  Workspace-to-sandbox file sync
│           ├── commands.ts        Command allowlisting
│           ├── paths.ts           Path normalization and security
│           ├── output.ts          UTF-8-safe output truncation
│           └── types.ts           Container-specific types (WorkspaceLike extends shared)
└── environments/
    ├── code-change/
    │   ├── flarbor/               Cloudflare Workers + DO implementation
    │   │   ├── src/index.ts       FlarborAgent + Worker entrypoint
    │   │   └── wrangler.jsonc     Cloudflare config
    │   └── harbor/                Docker container implementation (comparison)
    │       ├── src/               Python agent using Harbor + LiteLLM
    │       ├── task/              Harbor task definition + Dockerfile
    │       └── run.sh             Convenience script
    └── repo-audit/
        └── flarbor/               Non-agentic audit environment
            ├── src/index.ts       RepoAuditAgent (extends FlarborEnvironment) + Worker
            └── wrangler.jsonc     Cloudflare config
```

## Key abstractions

### flarbor-shared (`packages/flarbor-shared/`)

Zero-dependency shared package containing types, utilities, and test helpers used across all packages. Eliminates type duplication and ensures consistent behavior:

- **Shared types**: `TokenUsage`, `CriterionContext`, `RewardResult`, `CriterionResult`, `RewardScore`, `AggregationStrategy`, `WorkspaceLike`
- **Glob matching**: Canonical `globToRegex` and `matchesGlob` (supports `*`, `**`, `?`)
- **Budget decay**: `budgetDecay(used, budget)` — linear 1.0→0.0 scoring curve
- **Dispatch**: `dispatchTask()` + `DispatchError` + `agentNameFor()` — canonical agent dispatch logic
- **Type guard**: `isTrialResult()` — runtime validation
- **Test helpers**: `mockWorkspace()`, `mockContext()` (import from `flarbor-shared/testing`)

### FlarborEnvironment (`packages/flarbor/src/environment.ts`)

Abstract base class extending `@cloudflare/think`. Handles:

- Model/prompt/tools wiring via `getEnvironmentConfig()`
- Code execution tool (Dynamic Workers) if optional LOADER binding is present
- `stepCount` accessor for subclasses to read accumulated step count
- `beforeToolCall`: blocks writes to protected paths (glob matching)
- `afterToolCall`: logs failures
- `onStepFinish`: accumulates token usage
- `onChatResponse`/`onChatError`: captures turn errors
- Chat recovery enabled by default

Subclasses implement `getEnvironmentConfig()` and `onRequest()`. The base class owns no workflow logic. Non-agentic environments (like repo-audit) can extend it for workspace/git infrastructure without using the agent loop.

### GitWorkspace (`packages/flarbor/src/workspace.ts`)

Wraps `@cloudflare/shell` Workspace + `@cloudflare/shell/git`. Provides `clone()`, `createBranch()`, `commitAndPush()`, `getChangedFiles()`. Single git handle reused across operations. Uses noCheckout + separate checkout to work around an isomorphic-git virtual FS issue.

### Reward kit (`packages/flarbor-reward/`)

Composable scoring. `criterion()` wraps an evaluate function. `reward()` groups criteria with an aggregation strategy. `run()` evaluates all rewards against a `CriterionContext` and returns a `RewardResult`. Built-in criteria cover files, diffs, tokens, and trajectories. `judge()` creates LLM-as-judge criteria. Budget-based criteria use `budgetDecay` from flarbor-shared.

### Job kit (`packages/flarbor-job/`)

Batch orchestration. `runJob()` expands tasks x agents x attempts, runs trials with bounded concurrency, retries orchestration failures, emits hooks, computes stats, and supports persistence hooks for DO storage. `JobObject` is a thin Durable Object adapter that delegates to `runJob` with a persistence callback for state snapshots. Public HTTP routes remain environment-owned.

## Package dependency graph

```
flarbor-shared              (zero dependencies — types, utilities, test helpers)
  ↑
flarbor                     (depends on flarbor-shared + @cloudflare/think, shell, codemode)
  ↑
flarbor-reward              (depends on flarbor-shared + ai)
flarbor-container           (depends on flarbor-shared + @cloudflare/sandbox, ai)
flarbor-job                 (depends on flarbor-shared + flarbor)
  ↑
environments/*              (depend on flarbor + flarbor-job/reward as needed)
```

## Conventions

- **pnpm** workspaces, `environments/**` glob for nested env dirs
- TypeScript strict mode, ES2022 target, bundler moduleResolution
- Source exports (no build step) — wrangler bundles TS directly
- Shared types and utilities live in `flarbor-shared` — no type duplication across packages
- Environment env vars as defaults, POST body overrides (see `resolveTaskConfig` in code-change env)
- Zod for input validation at environment boundaries
- Apache-2.0 license

## Adding a new environment

1. Create `environments/<task-name>/flarbor/` with `package.json`, `wrangler.jsonc`, `tsconfig.json`, `src/index.ts`
2. Subclass `FlarborEnvironment`, implement `getEnvironmentConfig()` and `onRequest()`
3. Add a Worker `fetch` handler that routes to the DO via `runTask()`
4. Optionally add a Harbor comparison at `environments/<task-name>/harbor/`

## Dependencies

| Package                | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `flarbor-shared`       | Shared types, glob, budgetDecay, dispatch, test helpers    |
| `@cloudflare/think`    | Agent harness (agentic loop, persistence, workspace tools) |
| `@cloudflare/shell`    | Workspace filesystem + git                                 |
| `@cloudflare/codemode` | Dynamic Worker code execution                              |
| `agents`               | Agent class, routing                                       |
| `ai`                   | Vercel AI SDK (model interface)                            |
| `zod`                  | Input validation (in environments)                         |
