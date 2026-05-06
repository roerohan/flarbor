# code-change (Harbor)

Harbor equivalent of the Flarbor PR-replay environment. Both do the same thing — check out a repo at a pre-PR commit, give the agent the PR description, let it re-implement the changes, then verify the result against the known-good diff. Allows benchmarking latency and cost between platforms.

See the [root README](../../../README.md) for the full comparison guide.

## Prerequisites

```bash
pip install harbor litellm
# or: uv tool install harbor && pip install litellm

# Docker must be running
```

## Running

```bash
export TASK_ID="zod-5855"
export ANTHROPIC_API_KEY="sk-ant-..."
export GITHUB_TOKEN="ghp_..."                  # optional, for push
export BRANCH="harbor/zod-5855"                # optional

./run.sh
```

### Available tasks

| Task ID    | Description                                |
| ---------- | ------------------------------------------ |
| `zod-5855` | zod: clone Map and Set in shallowClone     |

### Environment variables

| Variable          | Required | Description                                          |
| ----------------- | -------- | ---------------------------------------------------- |
| `TASK_ID`         | Yes      | PR-replay task identifier (e.g. `zod-5855`)          |
| `ANTHROPIC_API_KEY` | Yes    | API key for Claude (or other model via LiteLLM)      |
| `GITHUB_TOKEN`    | No       | GitHub token for clone/push authentication            |
| `BRANCH`          | No       | Branch name to create (auto-generated if omitted)     |
| `MODEL_NAME`      | No       | LiteLLM model identifier (default: `anthropic/claude-sonnet-4-20250514`) |
| `AUTHOR_NAME`     | No       | Git author name (default: `Harbor Agent`)             |
| `AUTHOR_EMAIL`    | No       | Git author email (default: `agent@harbor.dev`)        |
| `MAX_STEPS`       | No       | Maximum agentic loop steps (default: `30`)            |

## Verification

The verifier (`task/tests/test.sh`) scores the agent's output across 4 criteria, mirroring the Flarbor side:

| Criterion      | Weight | Description                                          |
| -------------- | ------ | ---------------------------------------------------- |
| Tests pass     | 0.50   | Run scoped test command in the cloned repo            |
| File patterns  | 0.20   | Check expected substrings in modified files           |
| File touch     | 0.20   | Penalise touching unexpected files                    |
| LLM judge      | 0.10   | Not available in bash; full marks by default          |

Results land in `trials/`. Token usage and timing are in the `trial_result.json` log files.
