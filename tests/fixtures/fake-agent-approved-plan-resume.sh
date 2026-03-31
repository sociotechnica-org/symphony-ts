#!/usr/bin/env bash
set -euo pipefail

PROMPT="$(cat)"
printf '%s' "$PROMPT" > .agent-prompt.txt

git config user.name "Symphony Test Agent"
git config user.email "symphony-agent@example.com"

PLAN_PATH="docs/plans/${SYMPHONY_ISSUE_NUMBER}-approved-plan-resume/plan.md"

if [[ ! -f "$PLAN_PATH" ]]; then
  mkdir -p "$(dirname "$PLAN_PATH")"
  cat > "$PLAN_PATH" <<EOF
# Issue ${SYMPHONY_ISSUE_NUMBER} Plan

## Goal

Exercise the approved-plan resume path.

## Summary

- Stop at plan-ready on the first run.
- Resume implementation only when the prompt shows approved plan lifecycle context.
EOF

  git add .agent-prompt.txt "$PLAN_PATH"
  git commit -m "Draft plan for ${SYMPHONY_ISSUE_IDENTIFIER}"
  git push origin "HEAD:${SYMPHONY_BRANCH_NAME}"

  cat > .plan-ready-comment.md <<EOF
Plan status: plan-ready

Plan path: \`${PLAN_PATH}\`
Issue branch: \`${SYMPHONY_BRANCH_NAME}\`
Plan link: https://github.com/sociotechnica-org/symphony-ts/blob/${SYMPHONY_BRANCH_NAME}/${PLAN_PATH}
Branch URL: https://github.com/sociotechnica-org/symphony-ts/tree/${SYMPHONY_BRANCH_NAME}
Compare URL: https://github.com/sociotechnica-org/symphony-ts/compare/main...${SYMPHONY_BRANCH_NAME}

Summary

- Ready for human review.
EOF

  gh issue comment "${SYMPHONY_ISSUE_NUMBER}" \
    --repo sociotechnica-org/symphony-ts \
    --body-file .plan-ready-comment.md
  exit 0
fi

if ! grep -q "Tracker lifecycle: missing-target" .agent-prompt.txt; then
  exit 0
fi

if ! grep -qi "Tracker lifecycle summary: Plan review approved" .agent-prompt.txt; then
  exit 0
fi

echo "implemented ${SYMPHONY_ISSUE_IDENTIFIER} after approved plan review" > IMPLEMENTED.txt
git add .agent-prompt.txt IMPLEMENTED.txt
git commit -m "Implement ${SYMPHONY_ISSUE_IDENTIFIER} after approved plan review"
git push origin "HEAD:${SYMPHONY_BRANCH_NAME}"
curl -sS -X POST "${MOCK_GITHUB_API_URL}/mock/branch-pushes" \
  -H 'content-type: application/json' \
  -d "{\"head\":\"${SYMPHONY_BRANCH_NAME}\"}" >/dev/null

gh pr create \
  --title "Implement ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --body "Automated PR for ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --base main \
  --head "${SYMPHONY_BRANCH_NAME}"
