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
RELEASE_STATE_CHECKER="$REPO_ROOT/bin/check-operator-release-state.ts"
READY_PROMOTER="$REPO_ROOT/bin/promote-operator-ready-issues.ts"
INSTANCE_KEY=""
DETACHED_SESSION_NAME=""
SELECTED_INSTANCE_ROOT=""
INSTANCE_STATE_ROOT=""
LOG_DIR=""
LOCK_DIR=""
LOCK_INFO_FILE=""
STATUS_JSON=""
STATUS_MD=""
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
  local updated_at
  updated_at="$(now_utc)"
  load_release_state_snapshot
  if [ -n "$RELEASE_STATE_REFRESH_ERROR" ]; then
    RELEASE_ADVANCEMENT_STATE="unavailable"
    RELEASE_STATE_SUMMARY="$RELEASE_STATE_REFRESH_ERROR"
    RELEASE_STATE_UPDATED_AT=""
    RELEASE_BLOCKING_PREREQUISITE_NUMBER=""
    RELEASE_BLOCKING_PREREQUISITE_IDENTIFIER=""
  fi

  cat >"$STATUS_JSON" <<EOF
{
  "version": 1,
  "state": "$(json_escape "$state")",
  "message": "$(json_escape "$message")",
  "updatedAt": "$(json_escape "$updated_at")",
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

  cat >"$STATUS_MD" <<EOF
# Symphony Operator Loop

- State: $state
- Message: $message
- Updated: $updated_at
- Repo root: $REPO_ROOT
- Instance key: $INSTANCE_KEY
- Detached session: $DETACHED_SESSION_NAME
- Selected instance root: $SELECTED_INSTANCE_ROOT
- Operator state root: $INSTANCE_STATE_ROOT
- Mode: $(if [ "$RUN_ONCE" -eq 1 ]; then printf 'once'; else printf 'continuous'; fi)
- Interval seconds: $INTERVAL_SECONDS
- Selected workflow: ${WORKFLOW_PATH:-n/a}
- Provider: $OPERATOR_PROVIDER
- Model: ${OPERATOR_MODEL:-default}
- Command source: $OPERATOR_COMMAND_SOURCE
- Base command: $BASE_OPERATOR_COMMAND
- Effective command: $EFFECTIVE_OPERATOR_COMMAND
- Resumable session enabled: $(if [ "$RESUME_SESSION" -eq 1 ]; then printf 'true'; else printf 'false'; fi)
- Session state: $SESSION_STATE
- Session mode: $OPERATOR_SESSION_MODE
- Session summary: $OPERATOR_SESSION_SUMMARY
- Session backend id: ${OPERATOR_SESSION_ID:-n/a}
- Session reset reason: ${OPERATOR_SESSION_RESET_REASON:-n/a}
- Standing context: $STANDING_CONTEXT
- Wake-up log: $WAKE_UP_LOG
- Release state: $RELEASE_STATE
- Release advancement state: $RELEASE_ADVANCEMENT_STATE
- Release summary: $RELEASE_STATE_SUMMARY
- Release blocked by prerequisite: ${RELEASE_BLOCKING_PREREQUISITE_IDENTIFIER:-${RELEASE_BLOCKING_PREREQUISITE_NUMBER:-n/a}}
- Ready promotion state: $READY_PROMOTION_STATE
- Ready promotion summary: $READY_PROMOTION_SUMMARY
- Ready promotion eligible issues: ${READY_PROMOTION_ELIGIBLE_ISSUES:-none}
- Ready promotion added: ${READY_PROMOTION_ADDED:-none}
- Ready promotion removed: ${READY_PROMOTION_REMOVED:-none}
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
  emit_terminal_trace "waking up (${OPERATOR_PROVIDER}${OPERATOR_MODEL:+/$OPERATOR_MODEL}; $(describe_cycle_terminal_mode))"
  write_status "acting" "Running operator wake-up cycle"
  if ! acquire_active_wake_up_lease; then
    LAST_CYCLE_FINISHED_AT="$(now_utc)"
    LAST_CYCLE_EXIT_CODE="1"
    return 1
  fi

  {
    printf '== Symphony operator cycle ==\n'
    printf 'started_at=%s\n' "$LAST_CYCLE_STARTED_AT"
    printf 'repo_root=%s\n' "$REPO_ROOT"
    printf 'instance_key=%s\n' "$INSTANCE_KEY"
    printf 'detached_session=%s\n' "$DETACHED_SESSION_NAME"
    printf 'selected_instance_root=%s\n' "$SELECTED_INSTANCE_ROOT"
    printf 'operator_state_root=%s\n' "$INSTANCE_STATE_ROOT"
    printf 'selected_workflow=%s\n' "${WORKFLOW_PATH:-}"
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
    export SYMPHONY_OPERATOR_RELEASE_STATE="$RELEASE_STATE"
    export SYMPHONY_OPERATOR_STATUS_JSON="$STATUS_JSON"
    export SYMPHONY_OPERATOR_STATUS_MD="$STATUS_MD"
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
  record_operator_cycle
  if ! refresh_release_state_nonfatal; then
    :
  fi
  if ! run_ready_promotion_nonfatal; then
    :
  fi

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

if [ ! -f "$RELEASE_STATE_CHECKER" ]; then
  echo "operator-loop: release-state checker not found: $RELEASE_STATE_CHECKER" >&2
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
