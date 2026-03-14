#!/usr/bin/env bash
set -euo pipefail

PROMPT="$(cat)"
printf '%s' "$PROMPT" > .agent-prompt.txt

git config user.name "Symphony Test Agent"
git config user.email "symphony-agent@example.com"

echo "blocking failure ${SYMPHONY_ISSUE_IDENTIFIER} attempt ${SYMPHONY_RUN_ATTEMPT}" > IMPLEMENTED.txt
git add .agent-prompt.txt IMPLEMENTED.txt
git commit -m "Open PR for ${SYMPHONY_ISSUE_IDENTIFIER}"
git push origin HEAD:${SYMPHONY_BRANCH_NAME}

gh pr create \
  --title "Implement ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --body "Automated PR for ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --base main \
  --head "${SYMPHONY_BRANCH_NAME}"

if [[ -n "${SYMPHONY_TEST_START_FILE:-}" ]]; then
  touch "${SYMPHONY_TEST_START_FILE}"
fi

if [[ -n "${SYMPHONY_TEST_RELEASE_FILE:-}" ]]; then
  for _ in $(seq 1 300); do
    if [[ -f "${SYMPHONY_TEST_RELEASE_FILE}" ]]; then
      break
    fi
    sleep 0.1
  done
fi

echo "simulated failure after PR open" >&2
exit 17
