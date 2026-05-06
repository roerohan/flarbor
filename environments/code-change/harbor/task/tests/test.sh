#!/bin/bash
# ---------------------------------------------------------------------------
# PR-replay verifier for Harbor — mirrors Flarbor's verifier.ts
#
# Delegates all scoring logic to an inline Python script for reliability
# (avoids bash quoting issues with JSON data).
#
# Reads the agent's output from /logs/agent/verifier_metadata.json,
# looks up the task definition, and scores the result across 4 criteria:
#
#   tests_pass      0.50  — run scoped test command in the cloned repo
#   file_patterns   0.20  — check expected substrings in modified files
#   file_touch      0.20  — penalise touching unexpected files
#   llm_judge       0.10  — (no LLM available in bash; full marks by default)
#
# Writes final score (0.0–1.0) to /logs/verifier/reward.txt
# ---------------------------------------------------------------------------

set -euo pipefail

mkdir -p /logs/verifier

# --- Run tests separately in bash (needs Node.js/pnpm) ---
# The Python scoring script reads the test result from a marker file.

REPO_DIR="/home/agent/repo"
METADATA_FILE="/logs/agent/verifier_metadata.json"
TEST_RESULT_FILE="/tmp/test_result"

# Default: tests not run
echo "0" > "$TEST_RESULT_FILE"

if [ -f "$METADATA_FILE" ]; then
    # Extract task info via Python (safe JSON handling)
    TASK_INFO=$(python3 << 'PYEOF'
import json, sys

with open("/logs/agent/verifier_metadata.json") as _f:
    meta = json.load(_f)

task_id = meta.get("taskId", "")

# Inline task definitions (mirrors tasks.py)
TASKS = {
    "zod-5855": {
        "setup_command": "pnpm install --frozen-lockfile",
        "test_command": "pnpm vitest run packages/zod/src/v4/classic/tests/default.test.ts",
    },
}

task = TASKS.get(task_id, {})
setup = task.get("setup_command", "")
test = task.get("test_command", "")
print(f"{setup}\n{test}")
PYEOF
    ) || true

    if [ -n "$TASK_INFO" ]; then
        SETUP_CMD=$(echo "$TASK_INFO" | head -1)
        TEST_CMD=$(echo "$TASK_INFO" | tail -1)

        if [ -n "$TEST_CMD" ] && command -v node &>/dev/null; then
            echo "=== Running tests ==="

            # Run setup if specified
            SETUP_OK=1
            if [ -n "$SETUP_CMD" ]; then
                echo "Setup: $SETUP_CMD"
                if (cd "$REPO_DIR" && eval "$SETUP_CMD" >/dev/null 2>&1); then
                    echo "Setup succeeded."
                else
                    echo "Setup failed."
                    SETUP_OK=0
                fi
            fi

            if [ "$SETUP_OK" -eq 1 ]; then
                echo "Tests: $TEST_CMD"
                if (cd "$REPO_DIR" && eval "$TEST_CMD" >/dev/null 2>&1); then
                    echo "Tests PASSED."
                    echo "1" > "$TEST_RESULT_FILE"
                else
                    echo "Tests FAILED."
                fi
            fi
        else
            echo "Node.js not available or no test command — skipping tests."
        fi
    fi
fi

# --- Score everything in Python ---

python3 << 'PYEOF'
import json
import os
import re
import sys

METADATA_FILE = "/logs/agent/verifier_metadata.json"
REWARD_FILE = "/logs/verifier/reward.txt"
TEST_RESULT_FILE = "/tmp/test_result"
REPO_DIR = "/home/agent/repo"

# Weights (must match Flarbor's verifier.ts)
W_TESTS = 0.50
W_PATTERNS = 0.20
W_TOUCH = 0.20
W_JUDGE = 0.10

# Task definitions (mirrors tasks.py)
TASKS = {
    "zod-5855": {
        "expected_files": [
            "packages/zod/src/v4/core/util.ts",
            "packages/zod/src/v4/classic/tests/default.test.ts",
        ],
        "expected_patterns": [
            {"path": "packages/zod/src/v4/core/util.ts", "contains": "instanceof Map) return new Map"},
            {"path": "packages/zod/src/v4/core/util.ts", "contains": "instanceof Set) return new Set"},
            {"path": "packages/zod/src/v4/classic/tests/default.test.ts", "contains": "defaulted Map"},
            {"path": "packages/zod/src/v4/classic/tests/default.test.ts", "contains": "defaulted Set"},
        ],
    },
}


def write_reward(score: float) -> None:
    with open(REWARD_FILE, "w") as f:
        f.write(f"{score:.4f}\n")


# Pre-flight
if not os.path.isfile(METADATA_FILE):
    print("No verifier_metadata.json found — agent did not complete.")
    write_reward(0.0)
    sys.exit(0)

with open(METADATA_FILE) as f:
    meta = json.load(f)

task_id = meta.get("taskId", "")
changed_files = meta.get("filesChanged", [])

task = TASKS.get(task_id)
if task is None:
    print(f"Unknown task: {task_id}")
    write_reward(0.0)
    sys.exit(0)

print(f"=== PR-Replay Verifier ===")
print(f"Task: {task_id}")
print(f"Changed files ({len(changed_files)}):")
for cf in changed_files:
    print(f"  - {cf}")
print()

# --- 1. Tests (0.50) ---
print(f"--- 1. Tests (weight: {W_TESTS}) ---")
try:
    with open(TEST_RESULT_FILE) as f:
        tests_score = float(f.read().strip())
except (OSError, ValueError):
    tests_score = 0.0
print(f"Tests score: {tests_score}")
print()

# --- 2. File patterns (0.20) ---
print(f"--- 2. File Patterns (weight: {W_PATTERNS}) ---")
patterns = task.get("expected_patterns", [])
matched = 0
if not patterns:
    patterns_score = 1.0
else:
    for p in patterns:
        file_path = os.path.join(REPO_DIR, p["path"])
        try:
            with open(file_path) as f:
                content = f.read()
            is_regex = p.get("regex", False)
            if is_regex:
                found = re.search(p["contains"], content) is not None
            else:
                found = p["contains"] in content
            if found:
                print(f"  MATCH: {p['path']} contains '{p['contains']}'")
                matched += 1
            else:
                print(f"  MISS:  {p['path']} missing '{p['contains']}'")
        except OSError:
            print(f"  MISS:  {p['path']} (file not found)")
    patterns_score = matched / len(patterns) if patterns else 1.0
if patterns:
    print(f"Patterns score: {patterns_score} ({matched}/{len(patterns)})")
else:
    print(f"Patterns score: {patterns_score} (no patterns defined)")
print()

# --- 3. File touch (0.20) ---
print(f"--- 3. File Touch (weight: {W_TOUCH}) ---")
if not changed_files:
    touch_score = 0.0
    print("No files changed — score 0.")
else:
    expected = set(task.get("expected_files", []))
    unexpected = [f for f in changed_files if f not in expected]
    if not unexpected:
        touch_score = 1.0
        print("All changed files are expected.")
    else:
        for u in unexpected:
            print(f"  Unexpected: {u}")
        penalty = len(unexpected) / len(changed_files)
        touch_score = max(0.0, 1.0 - penalty)
        print(f"{len(unexpected)} unexpected file(s) out of {len(changed_files)} changed.")
print(f"File touch score: {touch_score}")
print()

# --- 4. LLM judge (0.10) ---
print(f"--- 4. LLM Judge (weight: {W_JUDGE}) ---")
print("No LLM available in verifier — granting full marks (1.0).")
judge_score = 1.0
print()

# --- Aggregate ---
final = (
    tests_score * W_TESTS
    + patterns_score * W_PATTERNS
    + touch_score * W_TOUCH
    + judge_score * W_JUDGE
)

print("=== Final Score ===")
print(f"  Tests:        {tests_score} * {W_TESTS} = {tests_score * W_TESTS:.4f}")
print(f"  Patterns:     {patterns_score} * {W_PATTERNS} = {patterns_score * W_PATTERNS:.4f}")
print(f"  File touch:   {touch_score} * {W_TOUCH} = {touch_score * W_TOUCH:.4f}")
print(f"  LLM judge:    {judge_score} * {W_JUDGE} = {judge_score * W_JUDGE:.4f}")
print(f"  ---")
print(f"  Total:        {final:.4f}")

write_reward(final)
print(f"\nReward written to {REWARD_FILE}")
PYEOF
