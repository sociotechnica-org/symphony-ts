#!/usr/bin/env bash
set -euo pipefail

PROMPT="$(cat)"
printf '%s' "$PROMPT" > .agent-prompt.txt

git config user.name "Symphony Test Agent"
git config user.email "symphony-agent@example.com"

PLAN_PATH="docs/plans/${SYMPHONY_ISSUE_NUMBER}-bootstrap-plan-review/plan.md"
mkdir -p "$(dirname "$PLAN_PATH")"
cat > "$PLAN_PATH" <<EOF
# Issue ${SYMPHONY_ISSUE_NUMBER} Plan

## Goal

Exercise the recoverable plan-review handoff.

## Summary

- Commit the reviewed plan.
- Push the issue branch before asking for review.
EOF

git add .agent-prompt.txt "$PLAN_PATH"
git commit -m "Draft plan for ${SYMPHONY_ISSUE_IDENTIFIER}"
git push origin "HEAD:${SYMPHONY_BRANCH_NAME}"

COMMENT_FILE=".plan-ready-comment.md"
cat > "$COMMENT_FILE" <<EOF
Plan status: plan-ready

Plan path: \`${PLAN_PATH}\`
Branch: \`${SYMPHONY_BRANCH_NAME}\`
Plan URL: https://github.com/sociotechnica-org/symphony-ts/blob/${SYMPHONY_BRANCH_NAME}/${PLAN_PATH}
Branch URL: https://github.com/sociotechnica-org/symphony-ts/tree/${SYMPHONY_BRANCH_NAME}
Compare URL: https://github.com/sociotechnica-org/symphony-ts/compare/main...${SYMPHONY_BRANCH_NAME}

Summary

- Commit the plan to the issue branch before review.
- Push the branch before posting this handoff.
- Make the reviewed plan recoverable from GitHub.

Review replies must start with one of these exact first-line markers: \`Plan review: approved\`, \`Plan review: changes-requested\`, or \`Plan review: waived\`.

\`\`\`\`md
\`\`\`md
Plan review: approved

Summary

- Approved to implement.
\`\`\`

\`\`\`md
Plan review: changes-requested

Summary

- One-sentence decision.

What is good

- ...

Required changes

- ...

Architecture / spec concerns

- ...

Slice / PR size concerns

- ...

Approval condition

- Approve after ...
\`\`\`

\`\`\`md
Plan review: waived

Summary

- Plan review is waived; proceed to implementation.
\`\`\`
\`\`\`\`
EOF

gh issue comment "${SYMPHONY_ISSUE_NUMBER}" \
  --repo sociotechnica-org/symphony-ts \
  --body-file "$COMMENT_FILE"
