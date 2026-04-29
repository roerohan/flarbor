# code-change (Harbor)

Harbor equivalent of the Flarbor code-change environment. Both do the same thing — clone a repo, make LLM-driven code changes, commit, and push — so you can benchmark latency and cost between platforms.

See the [root README](../../../README.md) for the full comparison guide.

## Prerequisites

```bash
pip install harbor litellm
# or: uv tool install harbor && pip install litellm

# Docker must be running
```

## Running

```bash
export REPO_URL="https://github.com/org/repo"
export GITHUB_TOKEN="ghp_..."
export ANTHROPIC_API_KEY="sk-ant-..."
export INSTRUCTION="Add error handling to the fetch calls in src/api.ts"
export BRANCH="harbor/add-error-handling"

./run.sh
```

Results land in `trials/`. Token usage and timing are in the `trial_result.json` log files.
