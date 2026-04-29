# Flarbor

Harbor alternative built on Cloudflare primitives. See [README.md](./README.md) for vision and usage.

## Repository structure

```
flarbor/
├── packages/
│   ├── flarbor/                 Core library
│   │   └── src/
│   │       ├── index.ts         Public API re-exports
│   │       ├── environment.ts   FlarborEnvironment — abstract Think subclass
│   │       ├── workspace.ts     GitWorkspace (Workspace + isomorphic-git)
│   │       ├── agent-runner.ts  runTask() — dispatches tasks to DO stubs
│   │       ├── glob.ts          Shared glob-to-regex utility
│   │       └── types.ts         TaskConfig, TrialResult, EnvironmentConfig, etc.
│   └── flarbor-reward/          Reward/scoring kit
│       └── src/
│           ├── index.ts         Public API re-exports
│           ├── types.ts         Criterion, Reward, RewardResult, JudgeConfig
│           ├── criterion.ts     criterion() builder
│           ├── reward.ts        reward() builder + aggregation
│           ├── runner.ts        run() — main scoring entry point
│           ├── judge.ts         LLM-as-judge criterion
│           └── criteria/
│               ├── file.ts      fileExists, fileContains, fileMatches, diffRatio
│               ├── diff.ts      hasChanges, diffSize, diffTouchesOnly, noDeletions
│               ├── token.ts     tokenBudget, tokenEfficiency, trialSuccess
│               └── trajectory.ts stepBudget, touchedFile, didNotTouch, minFilesChanged
└── environments/
    └── code-change/
        ├── flarbor/             Cloudflare Workers + DO implementation
        │   ├── src/index.ts     FlarborAgent + Worker entrypoint
        │   └── wrangler.jsonc   Cloudflare config
        └── harbor/              Docker container implementation (comparison)
            ├── src/             Python agent using Harbor + LiteLLM
            ├── task/            Harbor task definition + Dockerfile
            └── run.sh           Convenience script
```

## Key abstractions

### FlarborEnvironment (`packages/flarbor/src/environment.ts`)

Abstract base class extending `@cloudflare/think`. Handles:
- Model/prompt/tools wiring via `getEnvironmentConfig()`
- Code execution tool (Dynamic Workers) if LOADER binding is present
- `beforeToolCall`: blocks writes to protected paths (glob matching)
- `afterToolCall`: logs failures
- `onStepFinish`: accumulates token usage
- `onChatResponse`/`onChatError`: captures turn errors
- Chat recovery enabled by default

Subclasses implement `getEnvironmentConfig()` and `onRequest()`. The base class owns no workflow logic.

### GitWorkspace (`packages/flarbor/src/workspace.ts`)

Wraps `@cloudflare/shell` Workspace + `@cloudflare/shell/git`. Provides `clone()`, `createBranch()`, `commitAndPush()`, `getChangedFiles()`. Single git handle reused across operations. Uses noCheckout + separate checkout to work around an isomorphic-git virtual FS issue.

### Reward kit (`packages/flarbor-reward/`)

Composable scoring. `criterion()` wraps an evaluate function. `reward()` groups criteria with an aggregation strategy. `run()` evaluates all rewards against a `CriterionContext` and returns a `RewardResult`. Built-in criteria cover files, diffs, tokens, and trajectories. `judge()` creates LLM-as-judge criteria.

## Conventions

- **pnpm** workspaces, `environments/**` glob for nested env dirs
- TypeScript strict mode, ES2022 target, bundler moduleResolution
- Source exports (no build step) — wrangler bundles TS directly
- `flarbor-reward` has no runtime dependency on the core package (duplicates `globToRegex` and `TokenUsage` to avoid cycles)
- Environment env vars as defaults, POST body overrides (see `resolveTaskConfig` in code-change env)
- Zod for input validation at environment boundaries
- Apache-2.0 license

## Adding a new environment

1. Create `environments/<task-name>/flarbor/` with `package.json`, `wrangler.jsonc`, `tsconfig.json`, `src/index.ts`
2. Subclass `FlarborEnvironment`, implement `getEnvironmentConfig()` and `onRequest()`
3. Add a Worker `fetch` handler that routes to the DO via `runTask()`
4. Optionally add a Harbor comparison at `environments/<task-name>/harbor/`

## Dependencies

| Package | Purpose |
|---|---|
| `@cloudflare/think` | Agent harness (agentic loop, persistence, workspace tools) |
| `@cloudflare/shell` | Workspace filesystem + git |
| `@cloudflare/codemode` | Dynamic Worker code execution |
| `agents` | Agent class, routing |
| `ai` | Vercel AI SDK (model interface) |
| `zod` | Input validation (in environments) |
