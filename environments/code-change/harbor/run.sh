#!/bin/bash
#
# Run the Harbor PR-replay environment for comparison with Flarbor.
#
# Usage:
#   export TASK_ID="zod-5855"
#   export GITHUB_TOKEN="ghp_..."                          # optional, for push
#   export ANTHROPIC_API_KEY="sk-ant-..."                   # required by LiteLLM
#   export MODEL_NAME="anthropic/claude-sonnet-4-20250514"  # optional
#   export BRANCH="harbor/zod-5855"                         # optional
#   ./run.sh
#
# Prerequisites:
#   pip install harbor litellm
#   # or: uv tool install harbor && uv pip install litellm
#
# This script runs the Harbor trial locally using Docker.
# The agent looks up the task by TASK_ID from the static task suite,
# clones the repo at the pre-PR commit, and re-implements the PR.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TASK_DIR="${SCRIPT_DIR}/task"
AGENT_IMPORT="code_change_agent.agent:CodeChangeAgent"

# Validate required env vars
if [ -z "${TASK_ID:-}" ]; then
    echo "Error: TASK_ID is required"
    echo ""
    echo "Usage: TASK_ID=zod-5855 ./run.sh"
    echo ""
    echo "Available tasks:"
    PYTHONPATH="${SCRIPT_DIR}/src:${PYTHONPATH:-}" python3 -c '
from code_change_agent.tasks import TASKS
for tid, task in TASKS.items():
    print(f"  {tid:20s} {task.name}")
' 2>/dev/null || echo "  (install project to see task list: pip install -e .)"
    exit 1
fi

# Look up task and write instruction.md dynamically.
# Pass TASK_ID and SCRIPT_DIR via environment (not shell interpolation)
# to avoid injection if they contain quotes or special characters.
TASK_INSTRUCTIONS=$(PYTHONPATH="${SCRIPT_DIR}/src:${PYTHONPATH:-}" python3 -c '
import os, sys
from code_change_agent.tasks import get_task
task_id = os.environ["TASK_ID"]
task = get_task(task_id)
if task is None:
    print(f"ERROR: Unknown task ID: {task_id}", file=sys.stderr)
    sys.exit(1)
print(task.instructions)
') || {
    echo "Error: Failed to look up task '${TASK_ID}'"
    echo "Make sure the project is installed: pip install -e ."
    exit 1
}

# Write task instructions so Harbor passes them to agent.run(instruction, ...)
printf '%s\n' "$TASK_INSTRUCTIONS" > "${TASK_DIR}/instruction.md"

# Default model
MODEL_NAME="${MODEL_NAME:-anthropic/claude-sonnet-4-20250514}"

echo "=== Harbor PR-Replay Agent ==="
echo "Task:        ${TASK_ID}"
echo "Branch:      ${BRANCH:-auto-generated}"
echo "Model:       ${MODEL_NAME}"
echo "================================="

# Record start time for latency comparison
START_TIME=$(python3 -c "import time; print(time.time())")

# Ensure the agent package is importable
export PYTHONPATH="${SCRIPT_DIR}/src:${PYTHONPATH:-}"

# Run via Harbor CLI
harbor run \
    -p "${TASK_DIR}" \
    --agent-import-path "${AGENT_IMPORT}" \
    -m "${MODEL_NAME}" \
    --env docker

END_TIME=$(python3 -c "import time; print(time.time())")
ELAPSED=$(python3 -c "print(f'{float($END_TIME) - float($START_TIME):.2f}')")

echo ""
echo "=== Timing ==="
echo "Total elapsed: ${ELAPSED}s"
echo ""
echo "Results are in the trials/ directory."
echo "Token usage and cost are in the trial_result.json log files."
