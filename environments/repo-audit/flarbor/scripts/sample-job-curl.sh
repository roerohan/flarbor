#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
JOB_ID="${JOB_ID:-audit-small-set}"
REPO_URL="${REPO_URL:-https://github.com/roerohan/flarbor}"
INSTRUCTIONS="${INSTRUCTIONS:-Audit docs, tests, packaging, maintainability, and deployment readiness.}"
CONCURRENCY="${CONCURRENCY:-1}"
ATTEMPTS="${ATTEMPTS:-1}"

curl -X POST "${BASE_URL}/jobs/run" \
  -H "content-type: application/json" \
  -d "$(cat <<JSON
{
  "id": "${JOB_ID}",
  "name": "Repo audit sample job",
  "attempts": ${ATTEMPTS},
  "concurrency": ${CONCURRENCY},
  "tasks": [
    {
      "id": "repo-audit-sample",
      "name": "Sample repo audit",
      "task": {
        "repoUrl": "${REPO_URL}",
        "instructions": "${INSTRUCTIONS}"
      }
    }
  ]
}
JSON
)"
