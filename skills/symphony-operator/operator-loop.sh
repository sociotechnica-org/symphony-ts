#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROMPT_FILE="$SCRIPT_DIR/operator-prompt.md"
RALPH_DIR="$REPO_ROOT/.ralph"
LOG_DIR="$RALPH_DIR/logs"
LOCK_DIR="$RALPH_DIR/operator-loop.lock"
LOCK_INFO_FILE="$LOCK_DIR/owner"
STATUS_JSON="$RALPH_DIR/status.json"
STATUS_MD="$RALPH_DIR/status.md"
SCRATCHPAD="$RALPH_DIR/operator-scratchpad.md"

INTERVAL_SECONDS="${SYMPHONY_OPERATOR_INTERVAL_SECONDS:-300}"
OPERATOR_COMMAND="${SYMPHONY_OPERATOR_COMMAND:-codex exec --dangerously-bypass-approvals-and-sandbox -C . -}"
RECORDING_SETTLE_SECONDS=1

RUN_ONCE=0
STOPPING=0
SLEEP_PID=""
LAST_STATE="idle"
LAST_MESSAGE="Not started"
LAST_LOG_FILE=""
LAST_CYCLE_STARTED_AT=""
LAST_CYCLE_FINISHED_AT=""
LAST_CYCLE_EXIT_CODE=""
NEXT_WAKE_AT=""

usage() {
  cat <<'EOF'
Usage: operator-loop.sh [--once] [--interval-seconds <seconds>] [--help]

Environment:
  SYMPHONY_OPERATOR_COMMAND           Command that reads the operator prompt from stdin.
                                      Default: codex exec --dangerously-bypass-approvals-and-sandbox -C . -
  SYMPHONY_OPERATOR_INTERVAL_SECONDS  Sleep interval for continuous mode. Default: 300

Examples:
  pnpm operator
  pnpm operator:once
  SYMPHONY_OPERATOR_INTERVAL_SECONDS=60 pnpm operator
EOF
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

now_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

future_utc() {
  node -e 'const interval = Number(process.argv[1]); if (!Number.isInteger(interval) || interval <= 0) process.exit(1); console.log(new Date(Date.now() + interval * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));' "$1"
}

pid_is_live() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

write_status() {
  local state="$1"
  local message="$2"
  local updated_at
  updated_at="$(now_utc)"
  LAST_STATE="$state"
  LAST_MESSAGE="$message"

  cat >"$STATUS_JSON" <<EOF
{
  "version": 1,
  "state": "$(json_escape "$state")",
  "message": "$(json_escape "$message")",
  "updatedAt": "$(json_escape "$updated_at")",
  "repoRoot": "$(json_escape "$REPO_ROOT")",
  "pid": $$,
  "runOnce": $(if [ "$RUN_ONCE" -eq 1 ]; then printf 'true'; else printf 'false'; fi),
  "intervalSeconds": $INTERVAL_SECONDS,
  "command": "$(json_escape "$OPERATOR_COMMAND")",
  "promptFile": "$(json_escape "$PROMPT_FILE")",
  "scratchpad": "$(json_escape "$SCRATCHPAD")",
  "lastCycle": {
    "startedAt": $(if [ -n "$LAST_CYCLE_STARTED_AT" ]; then printf '"%s"' "$(json_escape "$LAST_CYCLE_STARTED_AT")"; else printf 'null'; fi),
    "finishedAt": $(if [ -n "$LAST_CYCLE_FINISHED_AT" ]; then printf '"%s"' "$(json_escape "$LAST_CYCLE_FINISHED_AT")"; else printf 'null'; fi),
    "exitCode": $(if [ -n "$LAST_CYCLE_EXIT_CODE" ]; then printf '%s' "$LAST_CYCLE_EXIT_CODE"; else printf 'null'; fi),
    "logFile": $(if [ -n "$LAST_LOG_FILE" ]; then printf '"%s"' "$(json_escape "$LAST_LOG_FILE")"; else printf 'null'; fi)
  },
  "nextWakeAt": $(if [ -n "$NEXT_WAKE_AT" ]; then printf '"%s"' "$(json_escape "$NEXT_WAKE_AT")"; else printf 'null'; fi)
}
EOF

  cat >"$STATUS_MD" <<EOF
# Symphony Operator Loop

- State: $state
- Message: $message
- Updated: $updated_at
- Repo root: $REPO_ROOT
- Mode: $(if [ "$RUN_ONCE" -eq 1 ]; then printf 'once'; else printf 'continuous'; fi)
- Interval seconds: $INTERVAL_SECONDS
- Scratchpad: $SCRATCHPAD
- Prompt: $PROMPT_FILE
- Last cycle started: ${LAST_CYCLE_STARTED_AT:-n/a}
- Last cycle finished: ${LAST_CYCLE_FINISHED_AT:-n/a}
- Last cycle exit code: ${LAST_CYCLE_EXIT_CODE:-n/a}
- Last cycle log: ${LAST_LOG_FILE:-n/a}
- Next wake: ${NEXT_WAKE_AT:-n/a}
EOF
}

ensure_runtime_paths() {
  mkdir -p "$LOG_DIR"

  if [ ! -f "$SCRATCHPAD" ]; then
    cat >"$SCRATCHPAD" <<'EOF'
# Operator Scratchpad

Local-only operator notes. Durable process changes belong in tracked docs,
skills, code, and plans instead of this file.
EOF
  fi
}

acquire_lock() {
  while true; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      cat >"$LOCK_INFO_FILE" <<EOF
pid=$$
started_at=$(now_utc)
repo_root=$REPO_ROOT
EOF
      return 0
    fi

    local existing_pid
    existing_pid="$(sed -n 's/^pid=//p' "$LOCK_INFO_FILE" 2>/dev/null | head -n 1)"
    if pid_is_live "$existing_pid"; then
      echo "operator-loop: another loop is already running with pid $existing_pid" >&2
      exit 1
    fi

    echo "operator-loop: clearing stale lock for pid ${existing_pid:-unknown}" >&2
    rm -rf "$LOCK_DIR"
    sleep 0.1
  done
}

release_lock() {
  if [ -d "$LOCK_DIR" ]; then
    local existing_pid
    existing_pid="$(sed -n 's/^pid=//p' "$LOCK_INFO_FILE" 2>/dev/null | head -n 1)"
    if [ "$existing_pid" = "$$" ]; then
      rm -rf "$LOCK_DIR"
    fi
  fi
}

on_signal() {
  STOPPING=1
  if [ -n "$SLEEP_PID" ] && pid_is_live "$SLEEP_PID"; then
    kill "$SLEEP_PID" 2>/dev/null || true
  fi
  write_status "stopping" "Signal received; stopping operator loop"
}

sleep_until_next_cycle() {
  sleep "$INTERVAL_SECONDS" &
  SLEEP_PID=$!
  wait "$SLEEP_PID" 2>/dev/null || true
  SLEEP_PID=""
}

run_cycle() {
  local timestamp log_file exit_code cycle_message
  timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
  log_file="$LOG_DIR/operator-cycle-$timestamp.log"

  LAST_LOG_FILE="$log_file"
  LAST_CYCLE_STARTED_AT="$(now_utc)"
  LAST_CYCLE_FINISHED_AT=""
  LAST_CYCLE_EXIT_CODE=""
  NEXT_WAKE_AT=""
  write_status "acting" "Running operator wake-up cycle"

  {
    printf '== Symphony operator cycle ==\n'
    printf 'started_at=%s\n' "$LAST_CYCLE_STARTED_AT"
    printf 'repo_root=%s\n' "$REPO_ROOT"
    printf 'command=%s\n' "$OPERATOR_COMMAND"
    printf 'prompt=%s\n' "$PROMPT_FILE"
    printf '\n'
  } >>"$log_file"

  set +e
  (
    cd "$REPO_ROOT"
    export SYMPHONY_OPERATOR_REPO_ROOT="$REPO_ROOT"
    export SYMPHONY_OPERATOR_SCRATCHPAD="$SCRATCHPAD"
    export SYMPHONY_OPERATOR_STATUS_JSON="$STATUS_JSON"
    export SYMPHONY_OPERATOR_STATUS_MD="$STATUS_MD"
    export SYMPHONY_OPERATOR_LOG_DIR="$LOG_DIR"
    export SYMPHONY_OPERATOR_PROMPT_FILE="$PROMPT_FILE"
    # Intentionally use a login shell so PATH-managed runner installs such as
    # codex or claude remain discoverable during unattended operator cycles.
    bash -l -c "$OPERATOR_COMMAND" <"$PROMPT_FILE"
  ) >>"$log_file" 2>&1
  exit_code=$?
  set -e

  LAST_CYCLE_FINISHED_AT="$(now_utc)"
  LAST_CYCLE_EXIT_CODE="$exit_code"

  if [ "$exit_code" -eq 0 ]; then
    cycle_message="Operator cycle completed successfully"
    write_status "recording" "$cycle_message"
    # Leave the post-cycle recording state visible briefly before callers
    # transition to the next wait state.
    sleep "$RECORDING_SETTLE_SECONDS"
  else
    cycle_message="Operator cycle failed with exit code $exit_code"
    write_status "failed" "$cycle_message"
  fi

  return "$exit_code"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
    --once)
      RUN_ONCE=1
      shift
      ;;
    --interval-seconds)
      if [ $# -lt 2 ]; then
        echo "operator-loop: --interval-seconds requires a value" >&2
        exit 1
      fi
      INTERVAL_SECONDS="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "operator-loop: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [ "$INTERVAL_SECONDS" -le 0 ]; then
  echo "operator-loop: interval must be a positive integer" >&2
  exit 1
fi

if [ ! -f "$PROMPT_FILE" ]; then
  echo "operator-loop: prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "operator-loop: node not found in PATH; required for timestamp calculation" >&2
  exit 1
fi

ensure_runtime_paths
write_status "acquiring-lock" "Preparing operator loop runtime paths"
trap on_signal INT TERM
trap 'release_lock' EXIT
acquire_lock

if [ "$RUN_ONCE" -eq 1 ]; then
  if run_cycle; then
    write_status "idle" "Operator loop finished one cycle"
    exit 0
  fi

  write_status "idle" "Operator loop finished one cycle with a failure"
  exit "${LAST_CYCLE_EXIT_CODE:-1}"
fi

write_status "sleeping" "Operator loop started"

while [ "$STOPPING" -eq 0 ]; do
  if run_cycle; then
    NEXT_WAKE_AT="$(future_utc "$INTERVAL_SECONDS")"
    write_status "sleeping" "Sleeping until next operator wake-up cycle"
  else
    NEXT_WAKE_AT="$(future_utc "$INTERVAL_SECONDS")"
    write_status "retrying" "Cycle failed; sleeping before retrying operator loop"
  fi

  sleep_until_next_cycle
done

write_status "idle" "Operator loop stopped"
