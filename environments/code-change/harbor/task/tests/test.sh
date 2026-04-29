#!/bin/bash
# Verifier: check if the agent made any changes and pushed them.
# For the comparison benchmark, we consider success if:
# 1. The trial_result.json exists in the logs directory
# 2. The result indicates success

RESULT_FILE="/logs/agent/trial_result.json"

if [ ! -f "$RESULT_FILE" ]; then
    echo "No trial_result.json found — agent did not complete."
    echo 0 > /logs/verifier/reward.txt
    exit 0
fi

# Check if success is true in the JSON
SUCCESS=$(python3 -c "import json; r=json.load(open('$RESULT_FILE')); print(1 if r.get('success') else 0)" 2>/dev/null)

if [ "$SUCCESS" = "1" ]; then
    echo "Agent completed successfully."
    echo 1 > /logs/verifier/reward.txt
else
    echo "Agent reported failure."
    echo 0 > /logs/verifier/reward.txt
fi
