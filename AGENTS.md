# Flarbor

Flarbor is a [Harbor](https://www.harborframework.com/docs) alternative built entirely on Cloudflare primitives. Where Harbor relies on Docker containers for durable execution and isolated environments, Flarbor replaces them with Durable Objects, Dynamic Workers, and the Cloudflare Agents SDK — achieving the same isolation and persistence model without containers for the core workflow.

Containers are only needed when running `npm build`, `npm test`, or other OS-level toolchains, and for that Flarbor defers to the [Sandbox SDK](https://developers.cloudflare.com/sandbox/).

## Repository Structure

```
flarbor/
├── AGENTS.md                              # This file
├── package.json                           # Root workspace config (npm workspaces)
├── pnpm-workspace.yaml                    # pnpm workspace definition
├── packages/
│   └── flarbor/                           # Core library ("flarbor" on npm)
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts                   # Public API exports
│           ├── environment.ts             # FlarborEnvironment — abstract Think subclass
│           ├── agent-runner.ts            # runTask() helper for dispatching tasks to DOs
│           ├── workspace.ts               # GitWorkspace class (Workspace + git handle)
│           └── types.ts                   # Shared types (TaskConfig, TrialResult, etc.)
└── environments/
    └── code-change-agent/                 # PoC environment: clone repo → Think → push
        ├── package.json
        ├── wrangler.jsonc
        ├── tsconfig.json
        └── src/
            └── index.ts                   # Worker entrypoint + thin FlarborAgent subclass
```

### packages/flarbor — the library

The core library provides `FlarborEnvironment`, an abstract base class that extends `@cloudflare/think`. It handles the full lifecycle:

| File | Class / Export | Purpose |
|---|---|---|
| `environment.ts` | `FlarborEnvironment` | Abstract Think subclass. Wires git workspace, code execution tool, session with context blocks, all lifecycle hooks (tool call safety, token tracking, error handling). Does not define any task workflow — environments own that. |
| `workspace.ts` | `GitWorkspace` | Wraps a `Workspace` + `Git` handle together. Provides `clone()`, `createBranch()`, `commitAndPush()`, `getChangedFiles()`. Single git handle reused across all operations. |
| `agent-runner.ts` | `runTask()` | Helper for Worker fetch handlers to dispatch a `TaskConfig` to a `FlarborEnvironment` DO stub and get a `TrialResult` back. |
| `types.ts` | `TaskConfig`, `TrialResult`, `EnvironmentConfig`, etc. | All shared types. `EnvironmentConfig` is what subclasses provide to configure the base class. |
| `index.ts` | re-exports | Public API surface. |

#### How FlarborEnvironment uses Think

`FlarborEnvironment` handles infrastructure — everything that is the same regardless of what kind of agent is running. Domain-specific configuration (model, prompt, session, tools, safety rules) comes from `getEnvironmentConfig()`.

**Infrastructure provided by the library (same for all environments):**

| Think Feature | How FlarborEnvironment Uses It |
|---|---|
| `getModel()` | Delegates to `getEnvironmentConfig().model` |
| `getTools()` | Merges custom tools from config + `createExecuteTool()` (code execution via Dynamic Workers) |
| `maxSteps` | Set per-task from `TaskConfig.maxSteps` or `EnvironmentConfig.maxSteps` (default 25) |
| `chatRecovery` | Enabled — turns are wrapped in `runFiber()` for crash recovery |
| `beforeToolCall()` | Blocks writes/edits/deletes to protected paths (from `EnvironmentConfig.protectedPaths`) |
| `afterToolCall()` | Logs tool failures with tool name and duration |
| `onStepFinish()` | Accumulates token usage (input/output/total) across all steps |
| `onChatResponse()` | Captures turn completion status and errors |
| `onChatError()` | Logs errors and captures them for the task result |
| `this.workspace` | Exposed via `GitWorkspace` which adds git operations on top |
| `tokenUsage` | Protected accessor — environments read accumulated token counts |
| `turnError` | Protected accessor — environments check if the inference turn errored |
| `resetTaskState()` | Protected method — environments call this to clear tracking between tasks |

**Domain-specific configuration provided by each environment via `getEnvironmentConfig()`:**

| Config Field | Purpose |
|---|---|
| `model` | Which LLM to use |
| `systemPrompt` | What the agent is and how it should behave |
| `configureSession` | Context blocks, compaction, search, skills — session-level memory |
| `tools` | Additional tools beyond workspace + execute |
| `maxSteps` | How many agentic loop steps before stopping |
| `protectedPaths` | Glob patterns for files the agent cannot modify |
| `enableCodeExecution` | Whether to wire the Dynamic Worker `execute` tool |

**Owned entirely by the environment (not the library):**

| Responsibility | Why |
|---|---|
| `fetch()` override | HTTP routing — different environments have different endpoints |
| Task workflow | The clone→branch→Think→commit→push flow is specific to code-change tasks. Other environments may not use git at all. |
| `saveMessages()` result handling | How to react to skipped turns or errors is workflow-specific |

#### Creating a new environment

Subclasses implement `getEnvironmentConfig()` with everything domain-specific:

```typescript
import { FlarborEnvironment } from "flarbor";
import type { EnvironmentConfig } from "flarbor";

export class MyAgent extends FlarborEnvironment<Env> {
  getEnvironmentConfig(): EnvironmentConfig {
    return {
      model: createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5"),
      systemPrompt: "You are a code review agent. Analyze the codebase and suggest improvements.",
      configureSession: (session) => session
        .withContext("findings", { description: "Issues found so far", maxTokens: 2000 })
        .withCachedPrompt(),
      maxSteps: 30,
      protectedPaths: [".git/**", ".github/workflows/**"],
      // tools: { myTool: tool({ ... }) },
      // enableCodeExecution: false,
    };
  }
}
```

### environments/

The `environments/` directory contains deployable Cloudflare Workers. Each environment is equivalent to a Harbor container environment — it defines what capabilities are available, what agent runs inside it, and how tasks are executed. The difference is that these are Workers + Durable Objects, not Docker containers.

Each environment is its own npm workspace with its own `wrangler.jsonc` and can be deployed independently. Environments are thin — typically under 50 lines — because `FlarborEnvironment` handles everything.

Future packages:

| Package | Purpose |
|---|---|
| `packages/flarbor` | Core library: FlarborEnvironment, GitWorkspace, task runner |
| `packages/flarbor-sandbox` | Sandbox SDK integration for `npm build` / `npm test` |
| `packages/flarbor-registry` | Task/dataset registry (equivalent to Harbor's registry) |
| `packages/flarbor-reward` | Reward/scoring kit for evaluating agent outputs |

Future environments:

| Environment | Purpose |
|---|---|
| `environments/code-change-agent` | PoC: clone a repo, make LLM-driven changes, push to a new branch |
| `environments/eval-runner` | Run a dataset of tasks against an agent and collect results |
| `environments/ci-agent` | Webhook-triggered agent that runs tests via Sandbox SDK |

## Concept Mapping: Harbor → Flarbor

| Harbor Concept | Harbor Implementation | Flarbor Equivalent | Cloudflare Primitive |
|---|---|---|---|
| **Environment** (`BaseEnvironment`) | Docker container | `FlarborEnvironment` (Durable Object + Workspace) | [Durable Objects](https://developers.cloudflare.com/durable-objects/) + [`@cloudflare/shell`](https://www.npmjs.com/package/@cloudflare/shell) |
| **Agent** (`BaseAgent`) | Program running in container | Think subclass via `FlarborEnvironment` | [`@cloudflare/think`](https://developers.cloudflare.com/agents/api-reference/think/) (Project Think) |
| **Task** | Instruction + test script | `TaskConfig` sent to `FlarborEnvironment.runTask()` | Think chat turn via `saveMessages()` |
| **Trial** | One agent attempt at a task | One `runTask()` invocation → `TrialResult` | Durable Object instance lifecycle |
| **Job** | Collection of trials | Orchestrator spawning sub-agents | Sub-agents via [DO Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/) |
| **Container filesystem** | Docker volume | `GitWorkspace` (Workspace + isomorphic-git) | [`Workspace`](https://www.npmjs.com/package/@cloudflare/shell) from `@cloudflare/shell` |
| **Shell access** | `docker exec` / SSH | `@cloudflare/shell` state API | [`state.*`](https://www.npmjs.com/package/@cloudflare/shell) operations in sandboxed Dynamic Workers |
| **Git operations** | `git` CLI in container | `GitWorkspace.clone/createBranch/commitAndPush` | Pure-JS git via `@cloudflare/shell/git` |
| **`npm test` / `npm build`** | Runs in Docker container | Sandbox SDK (container spun up on demand) | [`@cloudflare/sandbox`](https://developers.cloudflare.com/sandbox/) |

## Execution Ladder

Cloudflare's execution model has 5 tiers. Flarbor maps to them as follows:

| Tier | What | Flarbor Use | Container Required? |
|---|---|---|---|
| **0: Workspace** | Durable virtual filesystem (SQLite + R2) | Clone repos, read/write/edit files, git operations | No |
| **1: Dynamic Worker** | Sandboxed V8 isolate, no network | LLM-generated code execution (Think's `execute` tool) | No |
| **2: Dynamic Worker + npm** | Isolate with bundled npm packages | Complex code execution with dependencies | No |
| **3: Browser** | Headless Chrome via Browser Run | Web scraping, screenshot-based testing | No |
| **4: Sandbox** | Full Linux container | `npm build`, `npm test`, compilers, OS toolchains | Yes |

The key insight: **Tiers 0-2 are sufficient for the core workflow** (clone → modify → push). Tier 4 (containers) is only needed for build/test commands that require a real OS environment. This means Flarbor can handle the most common agent tasks without ever spinning up a container.

The PoC (`code-change-agent`) uses Tiers 0 and 1:
- **Tier 0**: `GitWorkspace` clones the repo, Think's workspace tools read/write/edit files, git commits and pushes
- **Tier 1**: `createExecuteTool()` lets the LLM write and execute JavaScript in a sandboxed Dynamic Worker for multi-file operations

## PoC: code-change-agent

The proof-of-concept environment demonstrates the core Flarbor workflow end-to-end without containers.

### What it does

1. Receives a `POST /run` request with a `TaskConfig` (repository URL, instructions, optional branch name)
2. Worker dispatches to a `FlarborAgent` Durable Object via `runTask()`
3. `FlarborEnvironment.runTask()` executes the full workflow:
   - Clones the repository into the workspace via `GitWorkspace`
   - Creates a new branch before the agentic loop
   - Runs the Think agentic loop with the instructions via `saveMessages()`
   - Validates the result (checks for skipped turns, errors, empty changesets)
   - Commits changes and pushes to the remote
4. Returns a `TrialResult` with branch, commit SHA, changed files, and token usage

### Runtime flow

```
Client POST /run { repoUrl, instructions, branch? }
        │
        ▼
  Worker fetch() handler
        │  dispatches via runTask() to DO by repo+branch name
        ▼
  FlarborAgent (Durable Object, extends FlarborEnvironment)
        │
        ├── 1. gitWorkspace.clone(repoUrl)
        ├── 2. gitWorkspace.createBranch(newBranch)
        ├── 3. saveMessages() → Think agentic loop
        │       ├── reads files with workspace tools (read, find, grep)
        │       ├── updates plan + memory context blocks
        │       ├── writes/edits files (blocked for protected paths)
        │       ├── optionally runs code via execute tool (Dynamic Worker)
        │       ├── token usage tracked per step via onStepFinish
        │       └── iterates until done or maxSteps reached
        ├── 4. validate: check saveMessages result, turnError, changedFiles
        ├── 5. gitWorkspace.commitAndPush({ branch, message, token })
        │
        ▼
  TrialResult { success, branch, commitSha, filesChanged, usage }
```

### The environment is thin

The entire `code-change-agent` environment is ~80 lines. It provides all domain-specific configuration — model, prompt, session memory, safety rules — while the library handles infrastructure:

```typescript
export class FlarborAgent extends FlarborEnvironment<Env> {
  getEnvironmentConfig(): EnvironmentConfig {
    return {
      model: createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5"),
      systemPrompt: "You are a code modification agent. Use workspace tools to make changes...",
      configureSession: (session) => session
        .withContext("plan", { description: "Current plan for the task", maxTokens: 1000 })
        .withContext("memory", { description: "Facts learned about the codebase", maxTokens: 2000 })
        .withCachedPrompt(),
      maxSteps: 30,
      protectedPaths: [".git/**", ".github/workflows/**"],
    };
  }
}
```

Plus a Worker fetch handler that routes `POST /run` to the DO via `runTask()`.

### Cloudflare primitives used

| Primitive | Binding / Config | Purpose |
|---|---|---|
| **Durable Objects** (SQLite) | `durable_objects.bindings` | Per-environment identity + persistent state |
| **Workspace** (`@cloudflare/shell`) | Part of DO storage | Virtual filesystem for cloned repo |
| **isomorphic-git** (`@cloudflare/shell/git`) | Via Workspace | Clone, branch, commit, push — no container |
| **Think** (`@cloudflare/think`) | Extends Agent | Agentic loop with built-in workspace tools |
| **Dynamic Workers** | `worker_loaders` binding | Sandboxed code execution for Think's `execute` tool |
| **Workers AI** | `ai` binding | LLM inference |

### Running the PoC

```bash
# From repo root
pnpm install

# Deploy the environment
pnpm --filter code-change-agent run deploy

# Or run locally
pnpm --filter code-change-agent run dev
```

```bash
# Trigger a code change
curl -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/org/repo",
    "instructions": "Add error handling to the fetch calls in src/api.ts",
    "branch": "flarbor/add-error-handling"
  }'
```

## Key Packages and Dependencies

### Core Cloudflare packages

| Package | Version | Purpose |
|---|---|---|
| [`agents`](https://www.npmjs.com/package/agents) | latest | Base Agent class, routing, React hooks |
| [`@cloudflare/think`](https://www.npmjs.com/package/@cloudflare/think) | latest | Opinionated Think base class (agentic loop, persistence, streaming, tools) |
| [`@cloudflare/shell`](https://www.npmjs.com/package/@cloudflare/shell) | latest | Workspace filesystem + `state.*` API + git operations |
| [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode) | latest | Sandboxed JS execution in Dynamic Workers |
| [`ai`](https://www.npmjs.com/package/ai) | latest | Vercel AI SDK (model interface used by Think) |
| [`workers-ai-provider`](https://www.npmjs.com/package/workers-ai-provider) | latest | Workers AI model provider for the AI SDK |
| [`zod`](https://www.npmjs.com/package/zod) | latest | Schema validation for tool parameters |

### Future dependencies (post-PoC)

| Package | Purpose |
|---|---|
| [`@cloudflare/sandbox`](https://www.npmjs.com/package/@cloudflare/sandbox) | Container execution for `npm build` / `npm test` |
| [`@cloudflare/worker-bundler`](https://www.npmjs.com/package/@cloudflare/worker-bundler) | Runtime npm resolution for Dynamic Workers (Tier 2) |

## Design Principles

1. **Containers are a last resort.** The core workflow (clone → modify → push) should never require a container. Containers are only for OS-level toolchains (build, test, compile).

2. **Each environment is a Durable Object.** This gives us per-environment identity, persistent state, zero cost when idle, and automatic scaling. A thousand environments cost nothing when they're not active.

3. **Think is the agent harness.** Instead of building a custom agentic loop, we use `@cloudflare/think` which handles the full chat lifecycle: tool execution, message persistence, streaming, abort/resume, and workspace file tools out of the box.

4. **Git via isomorphic-git, not containers.** `@cloudflare/shell/git` provides clone, branch, commit, push backed by the Workspace virtual filesystem. No `git` binary, no container, no SSH.

5. **The library is separate from environments.** `packages/flarbor` is the reusable core — it can be imported by any environment or published to npm. Environments in `environments/` are deployable applications that compose the library with Cloudflare config.

6. **Environments are thin.** All the Think integration, lifecycle hooks, git operations, error handling, and task execution live in `FlarborEnvironment`. An environment subclass only provides `getEnvironmentConfig()` — typically under 50 lines.

## Think Base Class Overview

Think (from `@cloudflare/think`) is the opinionated agent harness that Flarbor builds on. Key capabilities:

- **Built-in workspace tools**: `read`, `write`, `edit`, `list`, `find`, `grep`, `delete` — available to the LLM on every turn
- **Agentic loop**: calls `streamText`, executes tool calls, appends results, loops until done or `maxSteps`
- **Message persistence**: tree-structured messages stored in SQLite, survives hibernation
- **Lifecycle hooks**: `beforeTurn`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChatResponse`
- **Durable execution**: `runFiber()` for crash recovery and checkpointing
- **Sub-agents**: isolated child agents via DO Facets with typed RPC
- **Sessions**: context blocks with LLM-writable persistent memory, non-destructive compaction, FTS5 search
- **Code execution**: `createExecuteTool()` runs LLM-generated JS in sandboxed Dynamic Workers

### Minimal Think subclass

```typescript
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";

export class MyAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }
}
```

This alone gives you a working chat agent with streaming, persistence, workspace tools, abort/cancel, error handling, and resumable streams.

## Future Roadmap

### Phase 1: PoC (current)
- [x] Repository structure with monorepo workspaces
- [x] `packages/flarbor` core library (`FlarborEnvironment`, `GitWorkspace`, task runner)
- [x] `environments/code-change-agent` PoC (clone → Think → push)
- [x] Think integration: session context blocks, lifecycle hooks, code execution, token tracking, error handling, chat recovery
- [ ] Deploy and validate end-to-end flow

### Phase 2: Build/Test Integration
- [ ] `packages/flarbor-sandbox` — Sandbox SDK wrapper
- [ ] Spin up containers on demand for `npm build` / `npm test`
- [ ] Bidirectional file sync between Workspace and Sandbox
- [ ] Stream build/test output back to the agent

### Phase 3: Eval Framework
- [ ] Task definition format (equivalent to Harbor's `task.toml`)
- [ ] Dataset support (collections of tasks)
- [ ] `packages/flarbor-reward` — reward/scoring kit
- [ ] `environments/eval-runner` — run datasets against agents
- [ ] Result collection and reporting

### Phase 4: Scale and Orchestration
- [ ] Job orchestrator using sub-agents (DO Facets)
- [ ] Parallel trial execution across DO instances
- [ ] `packages/flarbor-registry` — task/dataset registry
- [ ] Webhook integrations for CI/CD triggers
- [ ] Scheduled runs via DO alarms
