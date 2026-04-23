#!/bin/bash
#
# Run the Harbor code-change-agent for latency/cost comparison with Flarbor.
#
# Usage:
#   export REPO_URL="https://github.com/org/repo"
#   export GITHUB_TOKEN="ghp_..."
#   export INSTRUCTION="Add error handling to the fetch calls in src/api.ts"
#   export BRANCH="harbor/add-error-handling"          # optional
#   export MODEL_NAME="openrouter/moonshotai/kimi-k2.5" # optional
#   ./run.sh
#
# Prerequisites:
#   pip install harbor litellm
#   # or: uv tool install harbor && uv pip install litellm
#
# This script runs the Harbor trial locally using Docker.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TASK_DIR="${SCRIPT_DIR}/task"
AGENT_IMPORT="code_change_agent.agent:CodeChangeAgent"

# Validate required env vars
if [ -z "${REPO_URL:-}" ]; then
    echo "Error: REPO_URL is required"
    echo "Usage: REPO_URL=https://github.com/org/repo INSTRUCTION='...' ./run.sh"
    exit 1
fi

if [ -z "${INSTRUCTION:-}" ]; then
    echo "Error: INSTRUCTION is required"
    echo "Usage: REPO_URL=https://github.com/org/repo INSTRUCTION='...' ./run.sh"
    exit 1
fi

# Write the instruction to instruction.md so Harbor picks it up
echo "$INSTRUCTION" > "${TASK_DIR}/instruction.md"

# Default model
MODEL_NAME="${MODEL_NAME:-openrouter/moonshotai/kimi-k2.5}"

echo "=== Harbor Code Change Agent ==="
echo "Repo:        ${REPO_URL}"
echo "Branch:      ${BRANCH:-auto-generated}"
echo "Model:       ${MODEL_NAME}"
echo "Instruction: ${INSTRUCTION:0:100}..."
echo "================================="

# Record start time for latency comparison
START_TIME=$(python3 -c "import time; print(time.time())")

# Run via Harbor CLI
harbor run \
    -p "${TASK_DIR}" \
    --agent-import-path "${AGENT_IMPORT}" \
    -m "${MODEL_NAME}" \
    --env docker

END_TIME=$(python3 -c "import time; print(time.time())")
ELAPSED=$(python3 -c "print(f'{${END_TIME} - ${START_TIME}:.2f}')")

echo ""
echo "=== Timing ==="
echo "Total elapsed: ${ELAPSED}s"
echo ""
echo "Results are in the trials/ directory."
echo "Token usage and cost are in the trial_result.json log files."
