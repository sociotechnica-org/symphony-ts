#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${SYMPHONY_WORKSPACE_PATH}/.flaky-attempt"
COUNT=0
if [[ -f "$STATE_FILE" ]]; then
  COUNT="$(cat "$STATE_FILE")"
fi
COUNT="$((COUNT + 1))"
printf '%s' "$COUNT" > "$STATE_FILE"

if [[ "$COUNT" -lt 2 ]]; then
  echo "simulated failure on attempt $COUNT" >&2
  exit 17
fi

PROMPT="$(cat)"
printf '%s' "$PROMPT" > .agent-prompt.txt

git config user.name "Symphony Test Agent"
git config user.email "symphony-agent@example.com"

echo "implemented after retry ${SYMPHONY_ISSUE_IDENTIFIER} attempt ${SYMPHONY_RUN_ATTEMPT}" > IMPLEMENTED.txt
git add .agent-prompt.txt IMPLEMENTED.txt "$STATE_FILE"
git commit -m "Implement ${SYMPHONY_ISSUE_IDENTIFIER} after retry"
git push origin HEAD:${SYMPHONY_BRANCH_NAME}

gh pr create \
  --title "Implement ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --body "Automated PR for ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --base main \
  --head "${SYMPHONY_BRANCH_NAME}"
