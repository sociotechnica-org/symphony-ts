#!/usr/bin/env bash
set -euo pipefail

# Fake agent that emits Codex-style JSON-RPC stdout events with token counts.
# Used for smoke-testing the TUI dashboard locally and in CI.
#
# Emits: session.start → reasoning (x5) → exec_command_begin → exec_command_end
#        → reasoning (x5) → exec_command_begin → exec_command_end → session.end
#
# Then commits a file and creates a PR, like a real agent would.
#
# Usage:
#   Set as agent.command in WORKFLOW.md for local TUI testing.
#   See src/observability/README.md for the full smoke-test setup.

# Read the prompt from stdin (required by Symphony)
PROMPT="$(cat)"
printf '%s' "$PROMPT" > .agent-prompt.txt

git config user.name "Symphony Smoke Agent"
git config user.email "smoke-agent@example.com"

# Simulate Codex-style stdout events with token counts
emit() {
  echo "$1"
  sleep 1
}

emit '{"method":"notifications/message","params":{"msg":{"payload":{"type":"session.start","session_id":"smoke-sess-001"}}}}'

# Simulate reasoning events with growing token counts
for i in $(seq 1 5); do
  TOKENS=$((i * 1200))
  INPUT=$((i * 800))
  OUTPUT=$((i * 400))
  emit "{\"method\":\"notifications/message\",\"params\":{\"msg\":{\"payload\":{\"type\":\"reasoning\",\"text\":\"Analyzing the codebase step ${i}...\",\"total_token_usage\":{\"input_tokens\":${INPUT},\"output_tokens\":${OUTPUT},\"total_tokens\":${TOKENS}}}}}}"
done

emit '{"method":"notifications/message","params":{"msg":{"payload":{"type":"exec_command_begin","command":"git status"}}}}'
sleep 2
emit '{"method":"notifications/message","params":{"msg":{"payload":{"type":"exec_command_end","exit_code":0}}}}'

for i in $(seq 6 10); do
  TOKENS=$((i * 1200))
  INPUT=$((i * 800))
  OUTPUT=$((i * 400))
  emit "{\"method\":\"notifications/message\",\"params\":{\"msg\":{\"payload\":{\"type\":\"reasoning\",\"text\":\"Implementing changes step ${i}...\",\"total_token_usage\":{\"input_tokens\":${INPUT},\"output_tokens\":${OUTPUT},\"total_tokens\":${TOKENS}}}}}}"
done

emit '{"method":"notifications/message","params":{"msg":{"payload":{"type":"exec_command_begin","command":"echo done"}}}}'
sleep 1
emit '{"method":"notifications/message","params":{"msg":{"payload":{"type":"exec_command_end","exit_code":0}}}}'

emit '{"method":"notifications/message","params":{"msg":{"payload":{"type":"session.end","total_token_usage":{"input_tokens":9600,"output_tokens":4800,"total_tokens":14400}}}}}'

# Do the actual work
echo "Smoke test for ${SYMPHONY_ISSUE_IDENTIFIER}" > SMOKE_TEST.txt
git add .agent-prompt.txt SMOKE_TEST.txt
git commit -m "Smoke test: implement ${SYMPHONY_ISSUE_IDENTIFIER}"
git push --force origin "HEAD:${SYMPHONY_BRANCH_NAME}"

gh pr create \
  --title "Smoke test: ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --body "Automated smoke test PR" \
  --base main \
  --head "${SYMPHONY_BRANCH_NAME}"
