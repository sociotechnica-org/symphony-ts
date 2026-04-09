#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROMPT_FILE="$SCRIPT_DIR/operator-prompt.md"
RUNTIME_ENTRYPOINT="$REPO_ROOT/bin/operator-loop.ts"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "operator-loop: prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

if [ ! -f "$RUNTIME_ENTRYPOINT" ]; then
  echo "operator-loop: runtime entrypoint not found: $RUNTIME_ENTRYPOINT" >&2
  exit 1
fi

if [ -x "$TSX_BIN" ]; then
  exec "$TSX_BIN" \
    "$RUNTIME_ENTRYPOINT" \
    --repo-root "$REPO_ROOT" \
    --prompt-file "$PROMPT_FILE" \
    "$@"
fi

if command -v pnpm >/dev/null 2>&1; then
  exec pnpm tsx \
    "$RUNTIME_ENTRYPOINT" \
    --repo-root "$REPO_ROOT" \
    --prompt-file "$PROMPT_FILE" \
    "$@"
fi

echo "operator-loop: tsx launcher not found: $TSX_BIN" >&2
exit 1
