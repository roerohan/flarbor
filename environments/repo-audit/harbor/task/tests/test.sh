#!/bin/bash
RESULT_FILE="/logs/agent/trial_result.json"
AUDIT_FILE="/logs/agent/repo-audit.json"

mkdir -p /logs/verifier

if [ ! -f "$RESULT_FILE" ] || [ ! -f "$AUDIT_FILE" ]; then
  echo "Missing repo audit outputs"
  echo '{"repo_audit":0}' > /logs/verifier/reward.json
  exit 0
fi

SUCCESS=$(python3 -c "import json; print(1 if json.load(open('$RESULT_FILE')).get('success') else 0)" 2>/dev/null)

if [ "$SUCCESS" = "1" ]; then
  echo "Repo audit completed successfully"
  echo '{"repo_audit":1}' > /logs/verifier/reward.json
else
  echo "Repo audit reported failure"
  echo '{"repo_audit":0}' > /logs/verifier/reward.json
fi
