#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROMPT_FILE="$SCRIPT_DIR/operator-prompt.md"
RALPH_DIR="$REPO_ROOT/.ralph"
INSTANCE_STATE_RESOLVER="$REPO_ROOT/bin/resolve-operator-instance.ts"
OPERATOR_CONFIG_RESOLVER="$REPO_ROOT/bin/resolve-operator-loop-config.ts"
PREPARE_OPERATOR_CYCLE="$REPO_ROOT/bin/prepare-operator-loop-cycle.ts"
RECORD_OPERATOR_CYCLE="$REPO_ROOT/bin/record-operator-loop-cycle.ts"
CONTROL_STATE_REFRESHER="$REPO_ROOT/bin/refresh-operator-control-state.ts"
RELEASE_STATE_CHECKER="$REPO_ROOT/bin/check-operator-release-state.ts"
READY_PROMOTER="$REPO_ROOT/bin/promote-operator-ready-issues.ts"
WRITE_OPERATOR_STATUS="$REPO_ROOT/bin/write-operator-status.ts"
UPDATE_OPERATOR_PROGRESS="${SYMPHONY_OPERATOR_PROGRESS_UPDATER_PATH:-$REPO_ROOT/bin/update-operator-progress.ts}"
INSTANCE_KEY=""
DETACHED_SESSION_NAME=""
SELECTED_INSTANCE_ROOT=""
INSTANCE_STATE_ROOT=""
LOG_DIR=""
LOCK_DIR=""
LOCK_INFO_FILE=""
STATUS_JSON=""
STATUS_MD=""
CONTROL_STATE=""
STANDING_CONTEXT=""
WAKE_UP_LOG=""
LEGACY_SCRATCHPAD=""
RELEASE_STATE=""
REPORT_REVIEW_STATE=""
SESSION_STATE=""
OPERATOR_COORDINATION_ROOT=""
ACTIVE_WAKE_UP_LOCK_DIR=""
ACTIVE_WAKE_UP_OWNER_FILE=""

INTERVAL_SECONDS="${SYMPHONY_OPERATOR_INTERVAL_SECONDS:-300}"
WORKFLOW_PATH="${SYMPHONY_OPERATOR_WORKFLOW_PATH:-}"
DEFAULT_OPERATOR_COMMAND="codex exec --dangerously-bypass-approvals-and-sandbox -C . -"
BASE_OPERATOR_COMMAND="$DEFAULT_OPERATOR_COMMAND"
EFFECTIVE_OPERATOR_COMMAND="$DEFAULT_OPERATOR_COMMAND"
OPERATOR_COMMAND_SOURCE="default"
OPERATOR_PROVIDER="codex"
OPERATOR_MODEL=""
RESUME_SESSION=0
OPERATOR_SESSION_MODE="disabled"
OPERATOR_SESSION_SUMMARY="Resumable operator sessions are disabled."
OPERATOR_SESSION_ID=""
OPERATOR_SESSION_RESET_REASON=""
RECORDING_SETTLE_SECONDS=1

RUN_ONCE=0
STOPPING=0
SLEEP_PID=""
LAST_LOG_FILE=""
LAST_CYCLE_STARTED_AT=""
LAST_CYCLE_FINISHED_AT=""
LAST_CYCLE_EXIT_CODE=""
NEXT_WAKE_AT=""
RELEASE_ADVANCEMENT_STATE="unavailable"
RELEASE_STATE_SUMMARY="Release state is unavailable."
RELEASE_STATE_UPDATED_AT=""
RELEASE_ID=""
RELEASE_BLOCKING_PREREQUISITE_NUMBER=""
RELEASE_BLOCKING_PREREQUISITE_IDENTIFIER=""
RELEASE_STATE_REFRESH_ERROR=""
READY_PROMOTION_STATE="unavailable"
READY_PROMOTION_SUMMARY="Ready promotion is unavailable."
READY_PROMOTION_UPDATED_AT=""
READY_PROMOTION_ELIGIBLE_ISSUES=""
READY_PROMOTION_ADDED=""
READY_PROMOTION_REMOVED=""
ACTIVE_WAKE_UP_LEASE_HELD=0
OPERATOR_CONTROL_POSTURE="runtime-blocked"
OPERATOR_CONTROL_SUMMARY="Operator control state is unavailable."
OPERATOR_CONTROL_BLOCKING_CHECKPOINT=""
OPERATOR_CONTROL_NEXT_ACTION_SUMMARY=""
PUBLISH_PROGRESS_ERROR=""

usage() {
  cat <<'EOF'
Usage: operator-loop.sh [--once] [--interval-seconds <seconds>] [--workflow <path>] [--provider <codex|claude|custom>] [--model <name>] [--operator-command <raw command>] [--resume-session|--infinite-session] [--help]

Environment:
  SYMPHONY_OPERATOR_COMMAND           Command that reads the operator prompt from stdin.
                                      Default: codex exec --dangerously-bypass-approvals-and-sandbox -C . -
                                      Warning: the default bypasses Codex approvals and sandboxing.
  SYMPHONY_OPERATOR_INTERVAL_SECONDS  Sleep interval for continuous mode. Default: 300
  SYMPHONY_OPERATOR_WORKFLOW_PATH     Optional WORKFLOW.md path for the target Symphony instance.

Examples:
  pnpm operator
  pnpm operator:once
  pnpm operator -- --provider codex --model gpt-5.4-mini
  pnpm operator -- --provider claude
  pnpm operator -- --provider codex --model gpt-5.4-mini --infinite-session
  pnpm operator -- --workflow ../target-repo/WORKFLOW.md
  SYMPHONY_OPERATOR_INTERVAL_SECONDS=60 pnpm operator
EOF
}

reject_nested_launch() {
  local message
  if [ "${SYMPHONY_OPERATOR_ACTIVE_PARENT_LOOP:-}" = "1" ]; then
    message="operator-loop: nested operator loop launch rejected inside an active wake-up cycle; reason=inherited-parent-loop"
    if [ -n "${SYMPHONY_OPERATOR_PARENT_LOOP_PID:-}" ]; then
      message="$message; parent_pid=${SYMPHONY_OPERATOR_PARENT_LOOP_PID}"
    fi
    if [ -n "${SYMPHONY_OPERATOR_PARENT_INSTANCE_KEY:-}" ]; then
      message="$message; parent_instance=${SYMPHONY_OPERATOR_PARENT_INSTANCE_KEY}"
    fi
    if [ -n "${SYMPHONY_OPERATOR_PARENT_WORKFLOW_PATH:-}" ]; then
      message="$message; parent_workflow=${SYMPHONY_OPERATOR_PARENT_WORKFLOW_PATH}"
    fi
    message="$message; requested_instance=${INSTANCE_KEY}"
    if [ -n "$WORKFLOW_PATH" ]; then
      message="$message; requested_workflow=${WORKFLOW_PATH}"
    fi

    echo "$message" >&2
    exit 1
  fi

  reject_launch_during_active_wake_up_lease
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

emit_terminal_trace() {
  local message="$1"
  printf '[%s] operator-loop: %s\n' "$(now_utc)" "$message" >&2
}

describe_cycle_terminal_mode() {
  case "$OPERATOR_SESSION_MODE" in
    resuming)
      if [ -n "$OPERATOR_SESSION_ID" ]; then
        printf 'resuming from %s' "$OPERATOR_SESSION_ID"
      else
        printf 'resuming'
      fi
      ;;
    fresh)
      printf 'starting fresh'
      ;;
    *)
      printf '%s' "$OPERATOR_SESSION_MODE"
      ;;
  esac
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
  selectedInstanceRoot: "SELECTED_INSTANCE_ROOT",
  instanceKey: "INSTANCE_KEY",
  detachedSessionName: "DETACHED_SESSION_NAME",
  operatorStateRoot: "INSTANCE_STATE_ROOT",
  logDir: "LOG_DIR",
  lockDir: "LOCK_DIR",
  lockInfoFile: "LOCK_INFO_FILE",
  statusJsonPath: "STATUS_JSON",
  statusMdPath: "STATUS_MD",
  controlStatePath: "CONTROL_STATE",
  standingContextPath: "STANDING_CONTEXT",
  wakeUpLogPath: "WAKE_UP_LOG",
  legacyScratchpadPath: "LEGACY_SCRATCHPAD",
  releaseStatePath: "RELEASE_STATE",
  reportReviewStatePath: "REPORT_REVIEW_STATE",
  sessionStatePath: "SESSION_STATE",
  operatorCoordinationRoot: "OPERATOR_COORDINATION_ROOT",
  activeWakeUpLockDir: "ACTIVE_WAKE_UP_LOCK_DIR",
  activeWakeUpOwnerFile: "ACTIVE_WAKE_UP_OWNER_FILE",
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

resolve_operator_config() {
  local config_json config_exports
  config_json="$(pnpm tsx "$OPERATOR_CONFIG_RESOLVER" "$@")"
  config_exports="$(
    printf '%s' "$config_json" | node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const mappings = {
  runOnce: "RUN_ONCE",
  intervalSeconds: "INTERVAL_SECONDS",
  workflowPath: "WORKFLOW_PATH",
  provider: "OPERATOR_PROVIDER",
  model: "OPERATOR_MODEL",
  baseCommand: "BASE_OPERATOR_COMMAND",
  commandSource: "OPERATOR_COMMAND_SOURCE",
  resumeSession: "RESUME_SESSION",
};
for (const [jsonKey, shellKey] of Object.entries(mappings)) {
  const value = data[jsonKey];
  if (jsonKey === "runOnce" || jsonKey === "resumeSession") {
    if (typeof value !== "boolean") {
      throw new Error(`Expected boolean for ${jsonKey}`);
    }
    console.log(`${shellKey}=${value ? "1" : "0"}`);
    continue;
  }
  if (jsonKey === "intervalSeconds") {
    if (typeof value !== "number") {
      throw new Error(`Expected number for ${jsonKey}`);
    }
    console.log(`${shellKey}=${JSON.stringify(String(value))}`);
    continue;
  }
  if (value !== null && typeof value !== "string") {
    throw new Error(`Expected string|null for ${jsonKey}`);
  }
  console.log(`${shellKey}=${JSON.stringify(value ?? "")}`);
}
'
  )"
  eval "$config_exports"
  EFFECTIVE_OPERATOR_COMMAND="$BASE_OPERATOR_COMMAND"
}

prepare_operator_cycle() {
  local prepared_json prepared_exports
  local args=(
    --provider "$OPERATOR_PROVIDER"
    --base-command "$BASE_OPERATOR_COMMAND"
    --resume-session "$(if [ "$RESUME_SESSION" -eq 1 ]; then printf 'true'; else printf 'false'; fi)"
    --session-state-path "$SESSION_STATE"
  )
  if [ -n "$OPERATOR_MODEL" ]; then
    args+=(--model "$OPERATOR_MODEL")
  fi
  prepared_json="$(pnpm tsx "$PREPARE_OPERATOR_CYCLE" "${args[@]}")"
  prepared_exports="$(
    printf '%s' "$prepared_json" | node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const mappings = {
  effectiveCommand: "EFFECTIVE_OPERATOR_COMMAND",
  sessionMode: "OPERATOR_SESSION_MODE",
  sessionSummary: "OPERATOR_SESSION_SUMMARY",
  backendSessionId: "OPERATOR_SESSION_ID",
  resetReason: "OPERATOR_SESSION_RESET_REASON",
};
for (const [jsonKey, shellKey] of Object.entries(mappings)) {
  const value = data[jsonKey];
  if (value !== null && typeof value !== "string") {
    throw new Error(`Expected string|null for ${jsonKey}`);
  }
  console.log(`${shellKey}=${JSON.stringify(value ?? "")}`);
}
'
  )"
  eval "$prepared_exports"
}

record_operator_cycle() {
  local recorded_json recorded_exports
  local args=(
    --provider "$OPERATOR_PROVIDER"
    --base-command "$BASE_OPERATOR_COMMAND"
    --resume-session "$(if [ "$RESUME_SESSION" -eq 1 ]; then printf 'true'; else printf 'false'; fi)"
    --session-mode "$OPERATOR_SESSION_MODE"
    --session-state-path "$SESSION_STATE"
    --repo-root "$REPO_ROOT"
    --started-at "$LAST_CYCLE_STARTED_AT"
    --finished-at "$LAST_CYCLE_FINISHED_AT"
    --exit-code "$LAST_CYCLE_EXIT_CODE"
    --log-file "$LAST_LOG_FILE"
    --reset-reason "$OPERATOR_SESSION_RESET_REASON"
  )
  if [ -n "$OPERATOR_MODEL" ]; then
    args+=(--model "$OPERATOR_MODEL")
  fi
  recorded_json="$(pnpm tsx "$RECORD_OPERATOR_CYCLE" "${args[@]}")"
  recorded_exports="$(
    printf '%s' "$recorded_json" | node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const mappings = {
  sessionSummary: "OPERATOR_SESSION_SUMMARY",
  backendSessionId: "OPERATOR_SESSION_ID",
};
for (const [jsonKey, shellKey] of Object.entries(mappings)) {
  const value = data[jsonKey];
  if (value !== null && typeof value !== "string") {
    throw new Error(`Expected string|null for ${jsonKey}`);
  }
  console.log(`${shellKey}=${JSON.stringify(value ?? "")}`);
}
'
  )"
  eval "$recorded_exports"
}

refresh_operator_control_state() {
  local control_json control_exports
  control_json="$(
    pnpm tsx "$CONTROL_STATE_REFRESHER" \
      --workflow "$WORKFLOW_PATH" \
      --operator-repo-root "$REPO_ROOT" \
      --json
  )"
  control_exports="$(
    printf '%s' "$control_json" | node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const mapping = {
  posture: "OPERATOR_CONTROL_POSTURE",
  summary: "OPERATOR_CONTROL_SUMMARY",
  blockingCheckpoint: "OPERATOR_CONTROL_BLOCKING_CHECKPOINT",
  nextActionSummary: "OPERATOR_CONTROL_NEXT_ACTION_SUMMARY",
};
for (const [jsonKey, shellKey] of Object.entries(mapping)) {
  const value = data[jsonKey];
  if (value !== null && typeof value !== "string") {
    throw new Error(`Expected string|null for ${jsonKey}`);
  }
  console.log(`${shellKey}=${JSON.stringify(value ?? "")}`);
}
'
  )"
  eval "$control_exports"
}

write_cycle_log_header() {
  local log_file="$1"

  {
    printf '== Symphony operator cycle ==\n'
    printf 'started_at=%s\n' "$LAST_CYCLE_STARTED_AT"
    printf 'repo_root=%s\n' "$REPO_ROOT"
    printf 'instance_key=%s\n' "$INSTANCE_KEY"
    printf 'detached_session=%s\n' "$DETACHED_SESSION_NAME"
    printf 'selected_instance_root=%s\n' "$SELECTED_INSTANCE_ROOT"
    printf 'operator_state_root=%s\n' "$INSTANCE_STATE_ROOT"
    printf 'selected_workflow=%s\n' "${WORKFLOW_PATH:-}"
    printf 'control_state=%s\n' "$CONTROL_STATE"
    printf 'control_posture=%s\n' "$OPERATOR_CONTROL_POSTURE"
    printf 'control_summary=%s\n' "$OPERATOR_CONTROL_SUMMARY"
    printf 'provider=%s\n' "$OPERATOR_PROVIDER"
    printf 'model=%s\n' "${OPERATOR_MODEL:-}"
    printf 'command_source=%s\n' "$OPERATOR_COMMAND_SOURCE"
    printf 'base_command=%s\n' "$BASE_OPERATOR_COMMAND"
    printf 'effective_command=%s\n' "$EFFECTIVE_OPERATOR_COMMAND"
    printf 'session_state=%s\n' "$SESSION_STATE"
    printf 'session_mode=%s\n' "$OPERATOR_SESSION_MODE"
    printf 'session_summary=%s\n' "$OPERATOR_SESSION_SUMMARY"
    printf 'session_backend_id=%s\n' "${OPERATOR_SESSION_ID:-}"
    printf 'prompt=%s\n' "$PROMPT_FILE"
    printf '\n'
  } >>"$log_file"
}

record_cycle_failure_before_command() {
  local log_file="$1"
  local failure_message="$2"
  local cycle_message="$3"

  LAST_CYCLE_FINISHED_AT="$(now_utc)"
  LAST_CYCLE_EXIT_CODE="1"

  {
    printf 'failure_at=%s\n' "$LAST_CYCLE_FINISHED_AT"
    printf 'failure=%s\n' "$failure_message"
  } >>"$log_file"

  write_status "failed" "$cycle_message"
  if ! publish_progress "cycle-failed" "$cycle_message"; then
    handle_progress_publish_failure "cycle-failed" "$PUBLISH_PROGRESS_ERROR"
    return 1
  fi
  record_operator_cycle
  write_status "failed" "$cycle_message"
}

refresh_release_state() {
  pnpm tsx "$RELEASE_STATE_CHECKER" \
    --workflow "$WORKFLOW_PATH" \
    --operator-repo-root "$REPO_ROOT" \
    --json >/dev/null
}

refresh_release_state_nonfatal() {
  local checker_output
  if checker_output="$(
    pnpm tsx "$RELEASE_STATE_CHECKER" \
      --workflow "$WORKFLOW_PATH" \
      --operator-repo-root "$REPO_ROOT" \
      --json 2>&1 >/dev/null
  )"; then
    RELEASE_STATE_REFRESH_ERROR=""
    return 0
  fi

  checker_output="$(printf '%s' "$checker_output" | tr '\r\n' ' ' | tr -s ' ')"
  RELEASE_STATE_REFRESH_ERROR="Release state refresh failed: ${checker_output:-unknown error}"
  echo "operator-loop: $RELEASE_STATE_REFRESH_ERROR" >&2
  return 1
}

run_ready_promotion_nonfatal() {
  local promoter_output
  if [ ! -f "$READY_PROMOTER" ]; then
    echo "operator-loop: ready promoter not found: $READY_PROMOTER" >&2
    return 1
  fi

  if promoter_output="$(
    pnpm tsx "$READY_PROMOTER" \
      --workflow "$WORKFLOW_PATH" \
      --operator-repo-root "$REPO_ROOT" \
      --json 2>&1 >/dev/null
  )"; then
    return 0
  fi

  promoter_output="$(printf '%s' "$promoter_output" | tr '\r\n' ' ' | tr -s ' ')"
  echo "operator-loop: ready promotion failed unexpectedly: ${promoter_output:-unknown error}" >&2
  return 1
}

load_release_state_snapshot() {
  local release_state_exports
  release_state_exports="$(
    RELEASE_STATE="$RELEASE_STATE" node -e '
const fs = require("node:fs");
const filePath = process.env.RELEASE_STATE;
  const defaults = {
    advancementState: "unavailable",
    summary: "Release state is unavailable.",
    updatedAt: "",
    releaseId: "",
    blockingPrerequisiteNumber: "",
    blockingPrerequisiteIdentifier: "",
    promotionState: "unavailable",
    promotionSummary: "Ready promotion is unavailable.",
    promotionUpdatedAt: "",
    promotionEligibleIssues: "",
    promotionAdded: "",
    promotionRemoved: "",
  };

try {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const evaluation =
    parsed && typeof parsed === "object" && parsed.evaluation && typeof parsed.evaluation === "object"
      ? parsed.evaluation
      : {};
  const blocking =
    evaluation && typeof evaluation === "object" && evaluation.blockingPrerequisite && typeof evaluation.blockingPrerequisite === "object"
      ? evaluation.blockingPrerequisite
      : {};

  defaults.advancementState =
    typeof evaluation.advancementState === "string"
      ? evaluation.advancementState
      : defaults.advancementState;
  defaults.summary =
    typeof evaluation.summary === "string" ? evaluation.summary : defaults.summary;
  defaults.updatedAt =
    typeof parsed.updatedAt === "string" ? parsed.updatedAt : defaults.updatedAt;
  defaults.releaseId =
    parsed &&
    typeof parsed === "object" &&
    parsed.configuration &&
    typeof parsed.configuration === "object" &&
    typeof parsed.configuration.releaseId === "string"
      ? parsed.configuration.releaseId
      : defaults.releaseId;
  defaults.blockingPrerequisiteNumber =
    typeof blocking.issueNumber === "number"
      ? String(blocking.issueNumber)
      : defaults.blockingPrerequisiteNumber;
  defaults.blockingPrerequisiteIdentifier =
    typeof blocking.issueIdentifier === "string"
      ? blocking.issueIdentifier
      : defaults.blockingPrerequisiteIdentifier;
  const promotion =
    parsed && typeof parsed === "object" && parsed.promotion && typeof parsed.promotion === "object"
      ? parsed.promotion
      : {};
  const eligibleIssues = Array.isArray(promotion.eligibleIssues)
    ? promotion.eligibleIssues
        .map((issue) =>
          issue && typeof issue === "object" && typeof issue.issueNumber === "number"
            ? String(issue.issueNumber)
            : null,
        )
        .filter((value) => value !== null)
    : [];
  const readyLabelsAdded = Array.isArray(promotion.readyLabelsAdded)
    ? promotion.readyLabelsAdded
        .map((issue) =>
          issue && typeof issue === "object" && typeof issue.issueNumber === "number"
            ? String(issue.issueNumber)
            : null,
        )
        .filter((value) => value !== null)
    : [];
  const readyLabelsRemoved = Array.isArray(promotion.readyLabelsRemoved)
    ? promotion.readyLabelsRemoved
        .map((issue) =>
          issue && typeof issue === "object" && typeof issue.issueNumber === "number"
            ? String(issue.issueNumber)
            : null,
        )
        .filter((value) => value !== null)
    : [];
  defaults.promotionState =
    typeof promotion.state === "string"
      ? promotion.state
      : defaults.promotionState;
  defaults.promotionSummary =
    typeof promotion.summary === "string"
      ? promotion.summary
      : defaults.promotionSummary;
  defaults.promotionUpdatedAt =
    typeof promotion.promotedAt === "string"
      ? promotion.promotedAt
      : defaults.promotionUpdatedAt;
  defaults.promotionEligibleIssues = eligibleIssues.join(",");
  defaults.promotionAdded = readyLabelsAdded.join(",");
  defaults.promotionRemoved = readyLabelsRemoved.join(",");
} catch (error) {
  if (!error || error.code !== "ENOENT") {
    defaults.summary = `Release state could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
}

for (const [key, value] of Object.entries(defaults)) {
  console.log(`${key}=${JSON.stringify(value)}`);
}
' \
      | node -e '
const fs = require("node:fs");
const lines = fs.readFileSync(0, "utf8").trim().split(/\n/u);
for (const line of lines) {
  if (!line) {
    continue;
  }
  const index = line.indexOf("=");
  const key = line.slice(0, index);
  const value = JSON.parse(line.slice(index + 1));
  const mapping = {
    advancementState: "RELEASE_ADVANCEMENT_STATE",
    summary: "RELEASE_STATE_SUMMARY",
    updatedAt: "RELEASE_STATE_UPDATED_AT",
    releaseId: "RELEASE_ID",
    blockingPrerequisiteNumber: "RELEASE_BLOCKING_PREREQUISITE_NUMBER",
    blockingPrerequisiteIdentifier: "RELEASE_BLOCKING_PREREQUISITE_IDENTIFIER",
    promotionState: "READY_PROMOTION_STATE",
    promotionSummary: "READY_PROMOTION_SUMMARY",
    promotionUpdatedAt: "READY_PROMOTION_UPDATED_AT",
    promotionEligibleIssues: "READY_PROMOTION_ELIGIBLE_ISSUES",
    promotionAdded: "READY_PROMOTION_ADDED",
    promotionRemoved: "READY_PROMOTION_REMOVED",
  };
  console.log(`${mapping[key]}=${JSON.stringify(value)}`);
}
'
  )"
  eval "$release_state_exports"
}

pid_is_live() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

read_active_wake_up_owner_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ACTIVE_WAKE_UP_OWNER_FILE" 2>/dev/null | head -n 1
}

clear_stale_active_wake_up_lease() {
  local existing_pid="${1:-}"
  echo "operator-loop: clearing stale active wake-up lease for pid ${existing_pid:-unknown}" >&2
  rm -rf "$ACTIVE_WAKE_UP_LOCK_DIR"
}

reject_launch_during_active_wake_up_lease() {
  while [ -d "$ACTIVE_WAKE_UP_LOCK_DIR" ]; do
    local existing_pid owner_repo_root owner_instance_root owner_workflow message
    existing_pid="$(read_active_wake_up_owner_value pid)"
    if ! pid_is_live "$existing_pid"; then
      clear_stale_active_wake_up_lease "$existing_pid"
      sleep 0.1
      continue
    fi

    owner_repo_root="$(read_active_wake_up_owner_value operator_repo_root)"
    owner_instance_root="$(read_active_wake_up_owner_value selected_instance_root)"
    owner_workflow="$(read_active_wake_up_owner_value workflow_path)"
    message="operator-loop: operator loop launch rejected while another wake-up cycle is active for this instance; reason=live-active-wake-up-lease; owner_pid=${existing_pid}"
    if [ -n "$owner_repo_root" ]; then
      message="$message; owner_repo_root=${owner_repo_root}"
    fi
    if [ -n "$owner_instance_root" ]; then
      message="$message; owner_selected_instance_root=${owner_instance_root}"
    fi
    if [ -n "$owner_workflow" ]; then
      message="$message; owner_workflow=${owner_workflow}"
    fi
    message="$message; requested_instance=${INSTANCE_KEY}"
    if [ -n "$WORKFLOW_PATH" ]; then
      message="$message; requested_workflow=${WORKFLOW_PATH}"
    fi

    echo "$message" >&2
    exit 1
  done
}

acquire_active_wake_up_lease() {
  mkdir -p "$OPERATOR_COORDINATION_ROOT"

  while true; do
    if mkdir "$ACTIVE_WAKE_UP_LOCK_DIR" 2>/dev/null; then
      ACTIVE_WAKE_UP_LEASE_HELD=1
      cat >"$ACTIVE_WAKE_UP_OWNER_FILE" <<EOF
pid=$$
started_at=$(now_utc)
selected_instance_root=$SELECTED_INSTANCE_ROOT
operator_repo_root=$REPO_ROOT
workflow_path=$WORKFLOW_PATH
instance_key=$INSTANCE_KEY
EOF
      return 0
    fi

    local existing_pid owner_repo_root owner_instance_root owner_workflow
    existing_pid="$(read_active_wake_up_owner_value pid)"
    if ! pid_is_live "$existing_pid"; then
      clear_stale_active_wake_up_lease "$existing_pid"
      sleep 0.1
      continue
    fi

    owner_repo_root="$(read_active_wake_up_owner_value operator_repo_root)"
    owner_instance_root="$(read_active_wake_up_owner_value selected_instance_root)"
    owner_workflow="$(read_active_wake_up_owner_value workflow_path)"
    echo "operator-loop: active wake-up lease already held for this instance; owner_pid=${existing_pid}; owner_repo_root=${owner_repo_root:-unknown}; owner_selected_instance_root=${owner_instance_root:-unknown}; owner_workflow=${owner_workflow:-unknown}" >&2
    return 1
  done
}

release_active_wake_up_lease() {
  if [ -d "$ACTIVE_WAKE_UP_LOCK_DIR" ]; then
    local existing_pid
    existing_pid="$(read_active_wake_up_owner_value pid)"
    if [ "$existing_pid" = "$$" ]; then
      rm -rf "$ACTIVE_WAKE_UP_LOCK_DIR"
    fi
  fi
  ACTIVE_WAKE_UP_LEASE_HELD=0
}

write_status() {
  local state="$1"
  local message="$2"
  local updated_at progress_json
  updated_at="$(now_utc)"
  progress_json="$(read_current_progress_json)"
  load_release_state_snapshot
  if [ -f "$CONTROL_STATE" ]; then
    local control_state_exports
    control_state_exports="$(
      CONTROL_STATE="$CONTROL_STATE" node -e '
const fs = require("node:fs");
const defaults = {
  OPERATOR_CONTROL_POSTURE: "runtime-blocked",
  OPERATOR_CONTROL_SUMMARY: "Operator control state is unavailable.",
  OPERATOR_CONTROL_BLOCKING_CHECKPOINT: "",
  OPERATOR_CONTROL_NEXT_ACTION_SUMMARY: "",
};
try {
  const raw = fs.readFileSync(process.env.CONTROL_STATE, "utf8");
  const parsed = JSON.parse(raw);
  defaults.OPERATOR_CONTROL_POSTURE =
    typeof parsed.posture === "string"
      ? parsed.posture
      : defaults.OPERATOR_CONTROL_POSTURE;
  defaults.OPERATOR_CONTROL_SUMMARY =
    typeof parsed.summary === "string"
      ? parsed.summary
      : defaults.OPERATOR_CONTROL_SUMMARY;
  defaults.OPERATOR_CONTROL_BLOCKING_CHECKPOINT =
    typeof parsed.blockingCheckpoint === "string"
      ? parsed.blockingCheckpoint
      : defaults.OPERATOR_CONTROL_BLOCKING_CHECKPOINT;
  defaults.OPERATOR_CONTROL_NEXT_ACTION_SUMMARY =
    typeof parsed.nextActionSummary === "string"
      ? parsed.nextActionSummary
      : defaults.OPERATOR_CONTROL_NEXT_ACTION_SUMMARY;
} catch (error) {
  defaults.OPERATOR_CONTROL_SUMMARY = `Operator control state could not be read: ${error instanceof Error ? error.message : String(error)}`;
}
for (const [key, value] of Object.entries(defaults)) {
  console.log(`${key}=${JSON.stringify(value)}`);
}
'
    )"
    eval "$control_state_exports"
  else
    OPERATOR_CONTROL_POSTURE="runtime-blocked"
    OPERATOR_CONTROL_SUMMARY="Operator control state has not been generated yet."
    OPERATOR_CONTROL_BLOCKING_CHECKPOINT=""
    OPERATOR_CONTROL_NEXT_ACTION_SUMMARY=""
  fi
  if [ -n "$RELEASE_STATE_REFRESH_ERROR" ]; then
    RELEASE_ADVANCEMENT_STATE="unavailable"
    RELEASE_STATE_SUMMARY="$RELEASE_STATE_REFRESH_ERROR"
    RELEASE_STATE_UPDATED_AT=""
    RELEASE_BLOCKING_PREREQUISITE_NUMBER=""
    RELEASE_BLOCKING_PREREQUISITE_IDENTIFIER=""
  fi
  cat <<EOF | pnpm tsx "$WRITE_OPERATOR_STATUS" --status-json "$STATUS_JSON" --status-md "$STATUS_MD"
{
  "version": 1,
  "state": "$(json_escape "$state")",
  "message": "$(json_escape "$message")",
  "updatedAt": "$(json_escape "$updated_at")",
  "progress": $progress_json,
  "repoRoot": "$(json_escape "$REPO_ROOT")",
  "instanceKey": "$(json_escape "$INSTANCE_KEY")",
  "detachedSessionName": "$(json_escape "$DETACHED_SESSION_NAME")",
  "selectedInstanceRoot": "$(json_escape "$SELECTED_INSTANCE_ROOT")",
  "operatorStateRoot": "$(json_escape "$INSTANCE_STATE_ROOT")",
  "pid": $$,
  "runOnce": $(if [ "$RUN_ONCE" -eq 1 ]; then printf 'true'; else printf 'false'; fi),
  "intervalSeconds": $INTERVAL_SECONDS,
  "provider": "$(json_escape "$OPERATOR_PROVIDER")",
  "model": $(if [ -n "$OPERATOR_MODEL" ]; then printf '"%s"' "$(json_escape "$OPERATOR_MODEL")"; else printf 'null'; fi),
  "commandSource": "$(json_escape "$OPERATOR_COMMAND_SOURCE")",
  "command": "$(json_escape "$BASE_OPERATOR_COMMAND")",
  "effectiveCommand": "$(json_escape "$EFFECTIVE_OPERATOR_COMMAND")",
  "promptFile": "$(json_escape "$PROMPT_FILE")",
  "operatorControl": {
    "path": "$(json_escape "$CONTROL_STATE")",
    "posture": "$(json_escape "$OPERATOR_CONTROL_POSTURE")",
    "summary": "$(json_escape "$OPERATOR_CONTROL_SUMMARY")",
    "blockingCheckpoint": $(if [ -n "$OPERATOR_CONTROL_BLOCKING_CHECKPOINT" ]; then printf '"%s"' "$(json_escape "$OPERATOR_CONTROL_BLOCKING_CHECKPOINT")"; else printf 'null'; fi),
    "nextActionSummary": $(if [ -n "$OPERATOR_CONTROL_NEXT_ACTION_SUMMARY" ]; then printf '"%s"' "$(json_escape "$OPERATOR_CONTROL_NEXT_ACTION_SUMMARY")"; else printf 'null'; fi)
  },
  "standingContext": "$(json_escape "$STANDING_CONTEXT")",
  "wakeUpLog": "$(json_escape "$WAKE_UP_LOG")",
  "operatorSession": {
    "enabled": $(if [ "$RESUME_SESSION" -eq 1 ]; then printf 'true'; else printf 'false'; fi),
    "path": "$(json_escape "$SESSION_STATE")",
    "mode": "$(json_escape "$OPERATOR_SESSION_MODE")",
    "summary": "$(json_escape "$OPERATOR_SESSION_SUMMARY")",
    "backendSessionId": $(if [ -n "$OPERATOR_SESSION_ID" ]; then printf '"%s"' "$(json_escape "$OPERATOR_SESSION_ID")"; else printf 'null'; fi),
    "resetReason": $(if [ -n "$OPERATOR_SESSION_RESET_REASON" ]; then printf '"%s"' "$(json_escape "$OPERATOR_SESSION_RESET_REASON")"; else printf 'null'; fi)
  },
  "releaseState": {
    "path": "$(json_escape "$RELEASE_STATE")",
    "releaseId": $(if [ -n "$RELEASE_ID" ]; then printf '"%s"' "$(json_escape "$RELEASE_ID")"; else printf 'null'; fi),
    "advancementState": "$(json_escape "$RELEASE_ADVANCEMENT_STATE")",
    "summary": "$(json_escape "$RELEASE_STATE_SUMMARY")",
    "updatedAt": $(if [ -n "$RELEASE_STATE_UPDATED_AT" ]; then printf '"%s"' "$(json_escape "$RELEASE_STATE_UPDATED_AT")"; else printf 'null'; fi),
    "blockingPrerequisiteNumber": $(if [ -n "$RELEASE_BLOCKING_PREREQUISITE_NUMBER" ]; then printf '%s' "$RELEASE_BLOCKING_PREREQUISITE_NUMBER"; else printf 'null'; fi),
    "blockingPrerequisiteIdentifier": $(if [ -n "$RELEASE_BLOCKING_PREREQUISITE_IDENTIFIER" ]; then printf '"%s"' "$(json_escape "$RELEASE_BLOCKING_PREREQUISITE_IDENTIFIER")"; else printf 'null'; fi),
    "promotion": {
      "state": "$(json_escape "$READY_PROMOTION_STATE")",
      "summary": "$(json_escape "$READY_PROMOTION_SUMMARY")",
      "updatedAt": $(if [ -n "$READY_PROMOTION_UPDATED_AT" ]; then printf '"%s"' "$(json_escape "$READY_PROMOTION_UPDATED_AT")"; else printf 'null'; fi),
      "eligibleIssueNumbers": $(printf '%s' "$READY_PROMOTION_ELIGIBLE_ISSUES" | node -e 'const fs = require("node:fs"); const raw = fs.readFileSync(0, "utf8").trim(); const values = raw === "" ? [] : raw.split(",").map((value) => Number(value)); process.stdout.write(JSON.stringify(values));'),
      "readyLabelsAdded": $(printf '%s' "$READY_PROMOTION_ADDED" | node -e 'const fs = require("node:fs"); const raw = fs.readFileSync(0, "utf8").trim(); const values = raw === "" ? [] : raw.split(",").map((value) => Number(value)); process.stdout.write(JSON.stringify(values));'),
      "readyLabelsRemoved": $(printf '%s' "$READY_PROMOTION_REMOVED" | node -e 'const fs = require("node:fs"); const raw = fs.readFileSync(0, "utf8").trim(); const values = raw === "" ? [] : raw.split(",").map((value) => Number(value)); process.stdout.write(JSON.stringify(values));')
    }
  },
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
}

read_current_progress_json() {
  if [ ! -f "$STATUS_JSON" ]; then
    printf 'null'
    return 0
  fi

  STATUS_JSON="$STATUS_JSON" node -e '
const fs = require("node:fs");
try {
  const raw = fs.readFileSync(process.env.STATUS_JSON, "utf8");
  const parsed = JSON.parse(raw);
  process.stdout.write(JSON.stringify(parsed.progress ?? null));
} catch (error) {
  process.stdout.write("null");
}
'
}

handle_progress_publish_failure() {
  local milestone="$1"
  local error_message="$2"
  local cycle_message="Operator cycle failed while publishing progress milestone ${milestone}: ${error_message:-unknown error}"

  emit_terminal_trace "$cycle_message"
  if [ -n "$LAST_LOG_FILE" ]; then
    {
      printf 'progress_publish_failure_at=%s\n' "$(now_utc)"
      printf 'progress_publish_failure_milestone=%s\n' "$milestone"
      printf 'progress_publish_failure=%s\n' "${error_message:-unknown error}"
    } >>"$LAST_LOG_FILE"
  fi

  if [ -z "$LAST_CYCLE_FINISHED_AT" ]; then
    LAST_CYCLE_FINISHED_AT="$(now_utc)"
  fi
  if [ -z "$LAST_CYCLE_EXIT_CODE" ] || [ "$LAST_CYCLE_EXIT_CODE" -eq 0 ]; then
    LAST_CYCLE_EXIT_CODE="1"
  fi

  if [ -n "$LAST_CYCLE_STARTED_AT" ] && [ -n "$LAST_LOG_FILE" ]; then
    record_operator_cycle
  fi
  write_status "failed" "$cycle_message"
}

publish_progress() {
  local milestone="$1"
  local summary="$2"
  local publish_output publish_status
  shift 2

  PUBLISH_PROGRESS_ERROR=""
  set +e
  publish_output="$(
    pnpm tsx "$UPDATE_OPERATOR_PROGRESS" \
      --status-json "$STATUS_JSON" \
      --status-md "$STATUS_MD" \
      --milestone "$milestone" \
      --summary "$summary" \
      "$@" 2>&1 >/dev/null
  )"
  publish_status=$?
  set -e

  if [ "$publish_status" -ne 0 ]; then
    publish_output="$(printf '%s' "$publish_output" | tr '\r\n' ' ' | tr -s ' ')"
    PUBLISH_PROGRESS_ERROR="${publish_output:-unknown error}"
    echo "operator-loop: failed to publish progress milestone ${milestone}: $PUBLISH_PROGRESS_ERROR" >&2
    return "$publish_status"
  fi

  return 0
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
    if ! refresh_release_state_nonfatal; then
      :
    fi
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

  if ! refresh_release_state_nonfatal; then
    :
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
  if [ "$OPERATOR_COMMAND_SOURCE" = "default" ]; then
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
  if ! refresh_release_state_nonfatal; then
    :
  fi
  if ! run_ready_promotion_nonfatal; then
    :
  fi
  prepare_operator_cycle
  refresh_operator_control_state
  write_cycle_log_header "$log_file"
  emit_terminal_trace "waking up (${OPERATOR_PROVIDER}${OPERATOR_MODEL:+/$OPERATOR_MODEL}; $(describe_cycle_terminal_mode))"
  write_status "acting" "Running operator wake-up cycle"
  if ! publish_progress "cycle-start" "Wake-up cycle started."; then
    handle_progress_publish_failure "cycle-start" "$PUBLISH_PROGRESS_ERROR"
    return 1
  fi
  if ! acquire_active_wake_up_lease; then
    record_cycle_failure_before_command \
      "$log_file" \
      "active wake-up lease already held for this instance" \
      "Operator cycle failed before the wake-up lease could be acquired"
    return 1
  fi

  set +e
  (
    cd "$REPO_ROOT"
    export SYMPHONY_OPERATOR_ACTIVE_PARENT_LOOP="1"
    export SYMPHONY_OPERATOR_PARENT_LOOP_PID="$$"
    export SYMPHONY_OPERATOR_PARENT_INSTANCE_KEY="$INSTANCE_KEY"
    export SYMPHONY_OPERATOR_PARENT_REPO_ROOT="$REPO_ROOT"
    export SYMPHONY_OPERATOR_PARENT_SELECTED_INSTANCE_ROOT="$SELECTED_INSTANCE_ROOT"
    export SYMPHONY_OPERATOR_PARENT_WORKFLOW_PATH="$WORKFLOW_PATH"
    export SYMPHONY_OPERATOR_REPO_ROOT="$REPO_ROOT"
    export SYMPHONY_OPERATOR_INSTANCE_KEY="$INSTANCE_KEY"
    export SYMPHONY_OPERATOR_DETACHED_SESSION_NAME="$DETACHED_SESSION_NAME"
    export SYMPHONY_OPERATOR_SELECTED_INSTANCE_ROOT="$SELECTED_INSTANCE_ROOT"
    export SYMPHONY_OPERATOR_STATE_ROOT="$INSTANCE_STATE_ROOT"
    export SYMPHONY_OPERATOR_STANDING_CONTEXT="$STANDING_CONTEXT"
    export SYMPHONY_OPERATOR_WAKE_UP_LOG="$WAKE_UP_LOG"
    export SYMPHONY_OPERATOR_LEGACY_SCRATCHPAD="$LEGACY_SCRATCHPAD"
    export SYMPHONY_OPERATOR_CONTROL_STATE="$CONTROL_STATE"
    export SYMPHONY_OPERATOR_CONTROL_POSTURE="$OPERATOR_CONTROL_POSTURE"
    export SYMPHONY_OPERATOR_CONTROL_SUMMARY="$OPERATOR_CONTROL_SUMMARY"
    export SYMPHONY_OPERATOR_RELEASE_STATE="$RELEASE_STATE"
    export SYMPHONY_OPERATOR_STATUS_JSON="$STATUS_JSON"
    export SYMPHONY_OPERATOR_STATUS_MD="$STATUS_MD"
    export SYMPHONY_OPERATOR_PROGRESS_UPDATER="$UPDATE_OPERATOR_PROGRESS"
    export SYMPHONY_OPERATOR_LOG_DIR="$LOG_DIR"
    export SYMPHONY_OPERATOR_PROMPT_FILE="$PROMPT_FILE"
    export SYMPHONY_OPERATOR_WORKFLOW_PATH="$WORKFLOW_PATH"
    export SYMPHONY_OPERATOR_REPORT_REVIEW_STATE="$REPORT_REVIEW_STATE"
    export SYMPHONY_OPERATOR_SESSION_STATE="$SESSION_STATE"
    export SYMPHONY_OPERATOR_PROVIDER="$OPERATOR_PROVIDER"
    export SYMPHONY_OPERATOR_MODEL="$OPERATOR_MODEL"
    export SYMPHONY_OPERATOR_COMMAND_SOURCE="$OPERATOR_COMMAND_SOURCE"
    export SYMPHONY_OPERATOR_BASE_COMMAND="$BASE_OPERATOR_COMMAND"
    export SYMPHONY_OPERATOR_EFFECTIVE_COMMAND="$EFFECTIVE_OPERATOR_COMMAND"
    export SYMPHONY_OPERATOR_SESSION_MODE="$OPERATOR_SESSION_MODE"
    # Intentionally use a login shell so PATH-managed runner installs such as
    # codex or claude remain discoverable during unattended operator cycles.
    bash -l -c "$EFFECTIVE_OPERATOR_COMMAND" <"$PROMPT_FILE"
  ) >>"$log_file" 2>&1
  exit_code=$?
  set -e
  release_active_wake_up_lease

  LAST_CYCLE_FINISHED_AT="$(now_utc)"
  LAST_CYCLE_EXIT_CODE="$exit_code"
  if ! refresh_release_state_nonfatal; then
    :
  fi
  if ! run_ready_promotion_nonfatal; then
    :
  fi
  if ! refresh_operator_control_state; then
    :
  fi

  if [ "$exit_code" -eq 0 ]; then
    cycle_message="Operator cycle completed successfully"
    write_status "recording" "$cycle_message"
    if ! publish_progress "cycle-finished" "$cycle_message"; then
      handle_progress_publish_failure "cycle-finished" "$PUBLISH_PROGRESS_ERROR"
      return 1
    fi
    record_operator_cycle
    write_status "recording" "$cycle_message"
    # Leave the post-cycle recording state visible briefly before callers
    # transition to the next wait state.
    sleep "$RECORDING_SETTLE_SECONDS"
  else
    cycle_message="Operator cycle failed with exit code $exit_code"
    write_status "failed" "$cycle_message"
    if ! publish_progress "cycle-failed" "$cycle_message"; then
      handle_progress_publish_failure "cycle-failed" "$PUBLISH_PROGRESS_ERROR"
      return 1
    fi
    record_operator_cycle
    write_status "failed" "$cycle_message"
  fi

  return "$exit_code"
}

for arg in "$@"; do
  if [ "$arg" = "--help" ] || [ "$arg" = "-h" ]; then
    usage
    exit 0
  fi
done

if [ ! -f "$PROMPT_FILE" ]; then
  echo "operator-loop: prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

if [ ! -f "$INSTANCE_STATE_RESOLVER" ]; then
  echo "operator-loop: instance-state resolver not found: $INSTANCE_STATE_RESOLVER" >&2
  exit 1
fi

if [ ! -f "$OPERATOR_CONFIG_RESOLVER" ]; then
  echo "operator-loop: operator config resolver not found: $OPERATOR_CONFIG_RESOLVER" >&2
  exit 1
fi

if [ ! -f "$PREPARE_OPERATOR_CYCLE" ]; then
  echo "operator-loop: operator cycle preparer not found: $PREPARE_OPERATOR_CYCLE" >&2
  exit 1
fi

if [ ! -f "$RECORD_OPERATOR_CYCLE" ]; then
  echo "operator-loop: operator cycle recorder not found: $RECORD_OPERATOR_CYCLE" >&2
  exit 1
fi

if [ ! -f "$CONTROL_STATE_REFRESHER" ]; then
  echo "operator-loop: operator control-state refresher not found: $CONTROL_STATE_REFRESHER" >&2
  exit 1
fi

if [ ! -f "$RELEASE_STATE_CHECKER" ]; then
  echo "operator-loop: release-state checker not found: $RELEASE_STATE_CHECKER" >&2
  exit 1
fi

if [ ! -f "$WRITE_OPERATOR_STATUS" ]; then
  echo "operator-loop: operator status writer not found: $WRITE_OPERATOR_STATUS" >&2
  exit 1
fi

if [ ! -f "$UPDATE_OPERATOR_PROGRESS" ]; then
  echo "operator-loop: operator progress updater not found: $UPDATE_OPERATOR_PROGRESS" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "operator-loop: node not found in PATH; required for timestamp calculation" >&2
  exit 1
fi

resolve_operator_config "$@"

if [ -n "$WORKFLOW_PATH" ]; then
  WORKFLOW_PATH="$(resolve_path "$WORKFLOW_PATH")"
else
  WORKFLOW_PATH="$(resolve_path "$REPO_ROOT/WORKFLOW.md")"
fi

resolve_instance_state
reject_nested_launch
warn_default_command
ensure_runtime_paths
trap 'release_active_wake_up_lease; release_lock' EXIT
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
emit_terminal_trace "going to sleep until the first wake-up cycle"

while [ "$STOPPING" -eq 0 ]; do
  if run_cycle; then
    if [ "$STOPPING" -eq 1 ]; then
      break
    fi
    NEXT_WAKE_AT="$(future_utc "$INTERVAL_SECONDS")"
    write_status "sleeping" "Sleeping until next operator wake-up cycle"
    emit_terminal_trace "going to sleep until $NEXT_WAKE_AT"
  else
    if [ "$STOPPING" -eq 1 ]; then
      break
    fi
    NEXT_WAKE_AT="$(future_utc "$INTERVAL_SECONDS")"
    write_status "retrying" "Cycle failed; sleeping before retrying operator loop"
    emit_terminal_trace "cycle failed; sleeping until $NEXT_WAKE_AT"
  fi

  sleep_until_next_cycle
done

write_status "idle" "Operator loop stopped"
