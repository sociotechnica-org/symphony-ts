#!/usr/bin/env bash
set -euo pipefail

PROMPT="$(cat)"
printf '%s' "$PROMPT" > .agent-prompt.txt

MARKER="$(dirname "$PWD")/.rate-limit-once-${SYMPHONY_ISSUE_NUMBER}"

if [[ ! -f "$MARKER" ]]; then
  touch "$MARKER"
  cat <<'JSON'
{"event":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"core","primary":{"used":100,"limit":100,"resetInMs":1000},"secondary":{"used":1,"limit":10,"resetInMs":10},"credits":"$4.00"}}}
JSON
  echo "HTTP 429 rate limit exceeded" >&2
  exit 1
fi

git config user.name "Symphony Test Agent"
git config user.email "symphony-test@example.com"

echo "Implemented ${SYMPHONY_ISSUE_IDENTIFIER}" > IMPLEMENTED.txt
git add .agent-prompt.txt IMPLEMENTED.txt
git commit -m "Implement ${SYMPHONY_ISSUE_IDENTIFIER}"
git push --force origin "HEAD:${SYMPHONY_BRANCH_NAME}"

gh pr create \
  --title "Implement ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --body "Automated PR for ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --base main \
  --head "${SYMPHONY_BRANCH_NAME}"
