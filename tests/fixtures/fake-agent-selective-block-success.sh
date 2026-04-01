#!/usr/bin/env bash
set -euo pipefail

PROMPT="$(cat)"
printf '%s' "$PROMPT" > .agent-prompt.txt

git config user.name "Symphony Test Agent"
git config user.email "symphony-agent@example.com"

if [[ "${SYMPHONY_ISSUE_NUMBER}" == "${SYMPHONY_TEST_BLOCK_ISSUE_NUMBER:-}" ]]; then
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
fi

echo "implemented ${SYMPHONY_ISSUE_IDENTIFIER}" > IMPLEMENTED.txt
git add .agent-prompt.txt IMPLEMENTED.txt
git commit -m "Implement ${SYMPHONY_ISSUE_IDENTIFIER}"
git push origin HEAD:${SYMPHONY_BRANCH_NAME}
curl -sS -X POST "${MOCK_GITHUB_API_URL}/mock/branch-pushes" \
  -H 'content-type: application/json' \
  -d "{\"head\":\"${SYMPHONY_BRANCH_NAME}\"}" >/dev/null

gh pr create \
  --title "Implement ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --body "Automated PR for ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --base main \
  --head "${SYMPHONY_BRANCH_NAME}"
