#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TASK_DIR="${SCRIPT_DIR}/task"
AGENT_IMPORT="repo_audit_agent.agent:RepoAuditAgent"

if [ -f "${SCRIPT_DIR}/.env" ]; then
  set -a
  source "${SCRIPT_DIR}/.env"
  set +a
fi

if [ -z "${REPO_URL:-}" ]; then
  echo "Error: REPO_URL is required"
  exit 1
fi

if [ -z "${INSTRUCTION:-}" ]; then
  echo "Error: INSTRUCTION is required"
  exit 1
fi

MODEL_NAME="${MODEL_NAME:-anthropic/claude-opus-4-6}"
printf '%s\n' "$INSTRUCTION" > "${TASK_DIR}/instruction.md"

echo "=== Harbor Repo Audit Agent ==="
echo "Repo:  ${REPO_URL}"
echo "Model: ${MODEL_NAME}"
echo "================================"

harbor run \
  -p "${TASK_DIR}" \
  --agent-import-path "${AGENT_IMPORT}" \
  -m "${MODEL_NAME}" \
  --env docker
