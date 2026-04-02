#!/usr/bin/env bash
set -euo pipefail

PROMPT="$(cat)"
printf '%s' "$PROMPT" > .agent-prompt.txt

git config user.name "Symphony Test Agent"
git config user.email "symphony-agent@example.com"

PLAN_PATH="docs/plans/${SYMPHONY_ISSUE_NUMBER}-custom-plan-review/plan.md"
mkdir -p "$(dirname "$PLAN_PATH")"
cat > "$PLAN_PATH" <<EOF
# Issue ${SYMPHONY_ISSUE_NUMBER} Plan

## Goal

Exercise the configurable plan-review handoff.

## Summary

- Commit the reviewed plan.
- Push the issue branch before asking for review.
- Use a workflow-configured plan-review marker.
EOF

git add .agent-prompt.txt "$PLAN_PATH"
git commit -m "Draft plan for ${SYMPHONY_ISSUE_IDENTIFIER}"
git push origin "HEAD:${SYMPHONY_BRANCH_NAME}"

COMMENT_FILE=".plan-ready-comment.md"
cat > "$COMMENT_FILE" <<EOF
Review status: ready-for-human-plan

Plan file: \`${PLAN_PATH}\`
Issue branch: \`${SYMPHONY_BRANCH_NAME}\`
Plan link: https://github.com/sociotechnica-org/symphony-ts/blob/${SYMPHONY_BRANCH_NAME}/${PLAN_PATH}
Branch link: https://github.com/sociotechnica-org/symphony-ts/tree/${SYMPHONY_BRANCH_NAME}
Diff link: https://github.com/sociotechnica-org/symphony-ts/compare/main...${SYMPHONY_BRANCH_NAME}

Summary

- Commit the plan to the issue branch before review.
- Push the branch before posting this handoff.
- Make the configured handoff recoverable from GitHub.

Review replies must start with one of these exact first-line markers: \`Review verdict: ship-it\`, \`Review verdict: needs-revision\`, or \`Review verdict: waived\`.

\`\`\`\`md
\`\`\`md
Review verdict: ship-it

Summary

- Approved to implement.
\`\`\`

\`\`\`md
Review verdict: needs-revision

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
Review verdict: waived

Summary

- Plan review is waived; proceed to implementation.
\`\`\`
\`\`\`\`
EOF

gh issue comment "${SYMPHONY_ISSUE_NUMBER}" \
  --repo sociotechnica-org/symphony-ts \
  --body-file "$COMMENT_FILE"
