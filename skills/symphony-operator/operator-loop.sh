#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROMPT_FILE="$SCRIPT_DIR/operator-prompt.md"
RALPH_DIR="$REPO_ROOT/.ralph"
INSTANCE_STATE_RESOLVER="$REPO_ROOT/bin/resolve-operator-instance.ts"
INSTANCE_KEY=""
DETACHED_SESSION_NAME=""
INSTANCE_STATE_ROOT=""
LOG_DIR=""
LOCK_DIR=""
LOCK_INFO_FILE=""
STATUS_JSON=""
STATUS_MD=""
STANDING_CONTEXT=""
WAKE_UP_LOG=""
LEGACY_SCRATCHPAD=""
REPORT_REVIEW_STATE=""

INTERVAL_SECONDS="${SYMPHONY_OPERATOR_INTERVAL_SECONDS:-300}"
WORKFLOW_PATH="${SYMPHONY_OPERATOR_WORKFLOW_PATH:-}"
DEFAULT_OPERATOR_COMMAND="codex exec --dangerously-bypass-approvals-and-sandbox -C . -"
OPERATOR_COMMAND="${SYMPHONY_OPERATOR_COMMAND:-$DEFAULT_OPERATOR_COMMAND}"
RECORDING_SETTLE_SECONDS=1

RUN_ONCE=0
STOPPING=0
SLEEP_PID=""
LAST_LOG_FILE=""
LAST_CYCLE_STARTED_AT=""
LAST_CYCLE_FINISHED_AT=""
LAST_CYCLE_EXIT_CODE=""
NEXT_WAKE_AT=""

usage() {
  cat <<'EOF'
Usage: operator-loop.sh [--once] [--interval-seconds <seconds>] [--workflow <path>] [--help]

Environment:
  SYMPHONY_OPERATOR_COMMAND           Command that reads the operator prompt from stdin.
                                      Default: codex exec --dangerously-bypass-approvals-and-sandbox -C . -
                                      Warning: the default bypasses Codex approvals and sandboxing.
  SYMPHONY_OPERATOR_INTERVAL_SECONDS  Sleep interval for continuous mode. Default: 300
  SYMPHONY_OPERATOR_WORKFLOW_PATH     Optional WORKFLOW.md path for the target Symphony instance.

Examples:
  pnpm operator
  pnpm operator:once
  pnpm operator -- --workflow ../target-repo/WORKFLOW.md
  SYMPHONY_OPERATOR_INTERVAL_SECONDS=60 pnpm operator
EOF
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\b'/\\b}"
  value="${value//$'\f'/\\f}"
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

resolve_path() {
  node -p 'require("node:path").resolve(process.argv[1])' "$1"
}

resolve_instance_state() {
  local metadata_json metadata_exports
  metadata_json="$(
    pnpm tsx "$INSTANCE_STATE_RESOLVER" \
      --workflow "$WORKFLOW_PATH" \
      --operator-repo-root "$REPO_ROOT"
  )"
  metadata_exports="$(
    printf '%s' "$metadata_json" | node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const mappings = {
  workflowPath: "WORKFLOW_PATH",
  instanceKey: "INSTANCE_KEY",
  detachedSessionName: "DETACHED_SESSION_NAME",
  operatorStateRoot: "INSTANCE_STATE_ROOT",
  logDir: "LOG_DIR",
  lockDir: "LOCK_DIR",
  lockInfoFile: "LOCK_INFO_FILE",
  statusJsonPath: "STATUS_JSON",
  statusMdPath: "STATUS_MD",
  standingContextPath: "STANDING_CONTEXT",
  wakeUpLogPath: "WAKE_UP_LOG",
  legacyScratchpadPath: "LEGACY_SCRATCHPAD",
  reportReviewStatePath: "REPORT_REVIEW_STATE",
};
for (const [jsonKey, shellKey] of Object.entries(mappings)) {
  const value = data[jsonKey];
  if (typeof value !== "string") {
    throw new Error(`Expected string for ${jsonKey}`);
  }
  console.log(`${shellKey}=${JSON.stringify(value)}`);
}
'
  )"
  eval "$metadata_exports"
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

  cat >"$STATUS_JSON" <<EOF
{
  "version": 1,
  "state": "$(json_escape "$state")",
  "message": "$(json_escape "$message")",
  "updatedAt": "$(json_escape "$updated_at")",
  "repoRoot": "$(json_escape "$REPO_ROOT")",
  "instanceKey": "$(json_escape "$INSTANCE_KEY")",
  "detachedSessionName": "$(json_escape "$DETACHED_SESSION_NAME")",
  "operatorStateRoot": "$(json_escape "$INSTANCE_STATE_ROOT")",
  "pid": $$,
  "runOnce": $(if [ "$RUN_ONCE" -eq 1 ]; then printf 'true'; else printf 'false'; fi),
  "intervalSeconds": $INTERVAL_SECONDS,
  "command": "$(json_escape "$OPERATOR_COMMAND")",
  "promptFile": "$(json_escape "$PROMPT_FILE")",
  "standingContext": "$(json_escape "$STANDING_CONTEXT")",
  "wakeUpLog": "$(json_escape "$WAKE_UP_LOG")",
  "reportReviewState": "$(json_escape "$REPORT_REVIEW_STATE")",
  "selectedWorkflowPath": $(if [ -n "$WORKFLOW_PATH" ]; then printf '"%s"' "$(json_escape "$WORKFLOW_PATH")"; else printf 'null'; fi),
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
- Instance key: $INSTANCE_KEY
- Detached session: $DETACHED_SESSION_NAME
- Operator state root: $INSTANCE_STATE_ROOT
- Mode: $(if [ "$RUN_ONCE" -eq 1 ]; then printf 'once'; else printf 'continuous'; fi)
- Interval seconds: $INTERVAL_SECONDS
- Selected workflow: ${WORKFLOW_PATH:-n/a}
- Standing context: $STANDING_CONTEXT
- Wake-up log: $WAKE_UP_LOG
- Report review state: $REPORT_REVIEW_STATE
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

  if [ -f "$LEGACY_SCRATCHPAD" ] && [ ! -f "$STANDING_CONTEXT" ] && [ ! -f "$WAKE_UP_LOG" ]; then
    {
      cat <<'EOF'
# Standing Context

Durable operator guidance for this selected Symphony instance belongs here.
Update this file intentionally when queue policy, release sequencing, campaign
notes, or known temporary workarounds change.

## Migrated Legacy Scratchpad

The prior `operator-scratchpad.md` content was preserved below during notebook
migration. Curate the durable guidance you still need from it here.

EOF
      cat "$LEGACY_SCRATCHPAD"
      printf '\n'
    } >"$STANDING_CONTEXT"

    cat >"$WAKE_UP_LOG" <<'EOF'
# Wake-Up Log

Append a new timestamped entry for each operator wake-up. Keep earlier entries
intact unless you are running an explicit maintenance or compaction flow.

## Migration Note

Legacy `operator-scratchpad.md` content was preserved in `standing-context.md`
when this notebook was initialized.
EOF
    return
  fi

  if [ ! -f "$STANDING_CONTEXT" ]; then
    cat >"$STANDING_CONTEXT" <<'EOF'
# Standing Context

Durable operator guidance for this selected Symphony instance belongs here.
Update this file intentionally when queue policy, release sequencing, campaign
notes, or known temporary workarounds change.
EOF
  fi

  if [ ! -f "$WAKE_UP_LOG" ]; then
    cat >"$WAKE_UP_LOG" <<'EOF'
# Wake-Up Log

Append a new timestamped entry for each operator wake-up. Keep earlier entries
intact unless you are running an explicit maintenance or compaction flow.
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

warn_default_command() {
  if [ "$OPERATOR_COMMAND" = "$DEFAULT_OPERATOR_COMMAND" ]; then
    echo "operator-loop: using the default Codex command with approvals and sandbox bypass enabled" >&2
  fi
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
    printf 'instance_key=%s\n' "$INSTANCE_KEY"
    printf 'detached_session=%s\n' "$DETACHED_SESSION_NAME"
    printf 'operator_state_root=%s\n' "$INSTANCE_STATE_ROOT"
    printf 'selected_workflow=%s\n' "${WORKFLOW_PATH:-}"
    printf 'command=%s\n' "$OPERATOR_COMMAND"
    printf 'prompt=%s\n' "$PROMPT_FILE"
    printf '\n'
  } >>"$log_file"

  set +e
  (
    cd "$REPO_ROOT"
    export SYMPHONY_OPERATOR_REPO_ROOT="$REPO_ROOT"
    export SYMPHONY_OPERATOR_INSTANCE_KEY="$INSTANCE_KEY"
    export SYMPHONY_OPERATOR_DETACHED_SESSION_NAME="$DETACHED_SESSION_NAME"
    export SYMPHONY_OPERATOR_STATE_ROOT="$INSTANCE_STATE_ROOT"
    export SYMPHONY_OPERATOR_STANDING_CONTEXT="$STANDING_CONTEXT"
    export SYMPHONY_OPERATOR_WAKE_UP_LOG="$WAKE_UP_LOG"
    export SYMPHONY_OPERATOR_LEGACY_SCRATCHPAD="$LEGACY_SCRATCHPAD"
    export SYMPHONY_OPERATOR_STATUS_JSON="$STATUS_JSON"
    export SYMPHONY_OPERATOR_STATUS_MD="$STATUS_MD"
    export SYMPHONY_OPERATOR_LOG_DIR="$LOG_DIR"
    export SYMPHONY_OPERATOR_PROMPT_FILE="$PROMPT_FILE"
    export SYMPHONY_OPERATOR_WORKFLOW_PATH="$WORKFLOW_PATH"
    export SYMPHONY_OPERATOR_REPORT_REVIEW_STATE="$REPORT_REVIEW_STATE"
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
    --workflow)
      if [ $# -lt 2 ]; then
        echo "operator-loop: --workflow requires a value" >&2
        exit 1
      fi
      WORKFLOW_PATH="$2"
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

if [ ! -f "$INSTANCE_STATE_RESOLVER" ]; then
  echo "operator-loop: instance-state resolver not found: $INSTANCE_STATE_RESOLVER" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "operator-loop: node not found in PATH; required for timestamp calculation" >&2
  exit 1
fi

if [ -n "$WORKFLOW_PATH" ]; then
  WORKFLOW_PATH="$(resolve_path "$WORKFLOW_PATH")"
else
  WORKFLOW_PATH="$(resolve_path "$REPO_ROOT/WORKFLOW.md")"
fi

resolve_instance_state
warn_default_command
ensure_runtime_paths
trap 'release_lock' EXIT
acquire_lock
trap on_signal INT TERM
# Only the lock owner should publish operator-loop status snapshots.
write_status "acquiring-lock" "Operator loop lock acquired; preparing runtime status"

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
    if [ "$STOPPING" -eq 1 ]; then
      break
    fi
    NEXT_WAKE_AT="$(future_utc "$INTERVAL_SECONDS")"
    write_status "sleeping" "Sleeping until next operator wake-up cycle"
  else
    if [ "$STOPPING" -eq 1 ]; then
      break
    fi
    NEXT_WAKE_AT="$(future_utc "$INTERVAL_SECONDS")"
    write_status "retrying" "Cycle failed; sleeping before retrying operator loop"
  fi

  sleep_until_next_cycle
done

write_status "idle" "Operator loop stopped"
