#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERVAL_SECONDS="${RALPH_INTERVAL_SECONDS:-300}"
MODEL="${RALPH_MODEL:-gpt-5.4}"
RESUME_MODE="${RALPH_RESUME_MODE:-last}"
SESSION_ID="${RALPH_SESSION_ID:-019cda6a-ef73-7183-89ba-32c377460c14}"
LOCK_DIR="${REPO_ROOT}/.ralph"
LOCK_FILE="${LOCK_DIR}/ralph-loop.lock"
LOG_DIR="${REPO_ROOT}/.ralph/logs"
STATUS_JSON_FILE="${LOCK_DIR}/status.json"
STATUS_MD_FILE="${LOCK_DIR}/status.md"
SCRATCHPAD_FILE="${LOCK_DIR}/operator-scratchpad.md"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${LOG_DIR}/ralph-loop-${TIMESTAMP}.log"

mkdir -p "${LOG_DIR}"
if [[ ! -f "${SCRATCHPAD_FILE}" ]]; then
  cat > "${SCRATCHPAD_FILE}" <<'EOF'
# Operator Scratchpad

Use this as the persistent notebook for the local factory run.

## Current State

- Worker:
- Active issue:
- Active PR:
- Queue:

## Open Risks

- None recorded yet.

## Next Checks

- Verify the factory is healthy.
EOF
fi

if [[ -e "${LOCK_FILE}" ]]; then
  EXISTING_PID="$(cat "${LOCK_FILE}" 2>/dev/null || true)"
  if [[ -n "${EXISTING_PID}" ]] && kill -0 "${EXISTING_PID}" 2>/dev/null; then
    echo "Ralph loop already running with pid ${EXISTING_PID}"
    exit 1
  fi
  rm -f "${LOCK_FILE}"
fi

echo "$$" > "${LOCK_FILE}"
cleanup() {
  rm -f "${LOCK_FILE}"
}
trap cleanup EXIT INT TERM

PROMPT="$(cat <<'EOF'
You are the operator and maintenance agent for the Symphony factory in this repository.

Read `skills/symphony-operator/SKILL.md` before acting and follow it for this wake-up cycle.
Read `.ralph/operator-scratchpad.md` at the start of the cycle and update it before finishing so important operator context persists across sessions.

Your job in this wake-up cycle:
1. Inspect the current state of the repo, the running factory, open issues, open PRs, CI, and reviews.
2. Use `pnpm tsx bin/symphony.ts factory status --json` as the primary factory-health check. Determine whether the detached runtime is healthy, degraded, stopped, making progress, stuck, crashed, or misconfigured.
3. Observe whether Symphony is running correctly and whether work is flowing.
4. If the factory is broken, stalled, misconfigured, stuck, or not running, fix the problem and restart it if necessary using `symphony factory start|stop|restart` unless the control surface itself is unavailable.
5. If a PR has actionable review or CI feedback, fix it, rerun local QA, push, and continue watching.
6. Do not act as a second scheduler. Rely on Symphony's own polling/concurrency to pick up queued work.
7. Only create or label the next concrete roadmap issue when the queue is empty, the current phase needs a new slice, or the factory would otherwise have nothing to do.
8. Keep concurrency conservative and avoid introducing unnecessary contention.
9. Do not stop at analysis if there is clear corrective or operational work to do.
10. Follow AGENTS.md and WORKFLOW.md exactly.

Operational assumptions for this cycle:
- The detached factory-control surface is the primary local runtime contract.
- Runner health is not just "is there a child process"; use factory-control state and runner visibility when available.
- The runtime may use `codex`, `claude-code`, or `generic-command`; do not assume every healthy run is a direct `codex exec` subprocess.

Before finishing this cycle:
- if you change tracked repository files to fix the factory, do that work on a branch, open or update a PR, get the fix merged to `main`, and restart the factory from the latest `main`
- update `.ralph/operator-scratchpad.md` with the current factory state, open risks, and the next operator checks
- run `/review` if you made implementation changes
- ensure local QA is run before merging any PR
- merge only when the branch is green and review feedback is addressed, unless blocked by an external stuck check
- assess whether anything from this wake-up should be added to `skills/symphony-operator/SKILL.md` or `.ralph/operator-scratchpad.md`:
  - durable process rules and generally-correct operating behavior belong in the skill or prompt
  - transient factory facts, temporary workarounds, and current-run context belong in the scratchpad
- leave a concise final status summary using exactly these standalone prefixes:
  ACTION:
  WORKER:
  ISSUE:
  PR:
  NEXT:
EOF
)"

echo "Starting Ralph loop"
echo "Repo: ${REPO_ROOT}"
echo "Interval: ${INTERVAL_SECONDS}s"
echo "Model: ${MODEL}"
echo "Resume mode: ${RESUME_MODE}"
echo "Log: ${LOG_FILE}"

run_fresh_exec() {
  codex exec \
    --dangerously-bypass-approvals-and-sandbox \
    -m "${MODEL}" \
    -C "${REPO_ROOT}" \
    "${PROMPT}"
}

safe_gh_json() {
  if gh "$@" 2>/dev/null; then
    return 0
  fi
  printf '[]'
}

safe_factory_control_json() {
  if pnpm tsx bin/symphony.ts factory status --json 2>/dev/null; then
    return 0
  fi
  printf '{}'
}

write_status_files() {
  local cycle_file="$1"
  local now
  local factory_control_json
  local ready_issues_json
  local running_issues_json
  local open_prs_json
  local action_line
  local worker_line
  local issue_line
  local pr_line
  local next_line

  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  factory_control_json="$(safe_factory_control_json)"
  ready_issues_json="$(safe_gh_json issue list --repo sociotechnica-org/symphony-ts --label symphony:ready --state open --json number,title,url)"
  running_issues_json="$(safe_gh_json issue list --repo sociotechnica-org/symphony-ts --label symphony:running --state open --json number,title,url)"
  open_prs_json="$(safe_gh_json pr list --repo sociotechnica-org/symphony-ts --state open --json number,title,url,headRefName,baseRefName)"

  action_line="$(grep '^ACTION:' "${cycle_file}" | tail -n 1 || true)"
  worker_line="$(grep '^WORKER:' "${cycle_file}" | tail -n 1 || true)"
  issue_line="$(grep '^ISSUE:' "${cycle_file}" | tail -n 1 || true)"
  pr_line="$(grep '^PR:' "${cycle_file}" | tail -n 1 || true)"
  next_line="$(grep '^NEXT:' "${cycle_file}" | tail -n 1 || true)"

  READY_ISSUES_JSON="${ready_issues_json}" \
  RUNNING_ISSUES_JSON="${running_issues_json}" \
  OPEN_PRS_JSON="${open_prs_json}" \
  FACTORY_CONTROL_JSON="${factory_control_json}" \
  STATUS_TIMESTAMP="${now}" \
  STATUS_LOG_FILE="${LOG_FILE}" \
  STATUS_ACTION_LINE="${action_line}" \
  STATUS_WORKER_LINE="${worker_line}" \
  STATUS_ISSUE_LINE="${issue_line}" \
  STATUS_PR_LINE="${pr_line}" \
  STATUS_NEXT_LINE="${next_line}" \
  node <<'EOF' > "${STATUS_JSON_FILE}"
const factoryControl = JSON.parse(process.env.FACTORY_CONTROL_JSON || "{}");
const statusSnapshot =
  factoryControl && typeof factoryControl === "object"
    ? factoryControl.statusSnapshot || null
    : null;
const worker =
  statusSnapshot &&
  typeof statusSnapshot === "object" &&
  statusSnapshot.worker &&
  typeof statusSnapshot.worker === "object"
    ? statusSnapshot.worker
    : null;

const status = {
  timestamp: process.env.STATUS_TIMESTAMP,
  logFile: process.env.STATUS_LOG_FILE,
  worker: {
    state:
      factoryControl && typeof factoryControl.controlState === "string"
        ? factoryControl.controlState
        : "unknown",
    alive:
      factoryControl && typeof factoryControl.workerAlive === "boolean"
        ? factoryControl.workerAlive
        : null,
    pid:
      worker && typeof worker.pid === "number" ? worker.pid : null,
    instanceId:
      worker && typeof worker.instanceId === "string"
        ? worker.instanceId
        : null,
    processIds:
      factoryControl && Array.isArray(factoryControl.processIds)
        ? factoryControl.processIds
        : [],
  },
  factoryControl,
  readyIssues: JSON.parse(process.env.READY_ISSUES_JSON || "[]"),
  runningIssues: JSON.parse(process.env.RUNNING_ISSUES_JSON || "[]"),
  openPrs: JSON.parse(process.env.OPEN_PRS_JSON || "[]"),
  operatorSummary: {
    action: process.env.STATUS_ACTION_LINE || "",
    worker: process.env.STATUS_WORKER_LINE || "",
    issue: process.env.STATUS_ISSUE_LINE || "",
    pr: process.env.STATUS_PR_LINE || "",
    next: process.env.STATUS_NEXT_LINE || "",
  },
};

process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
EOF

  {
    echo "# Ralph Status"
    echo
    echo "- Timestamp: ${now}"
    echo "- Log file: ${LOG_FILE}"
    echo
    echo "## Factory Control"
    echo
    FACTORY_CONTROL_MD_JSON="${factory_control_json}" node <<'EOF'
const snapshot = JSON.parse(process.env.FACTORY_CONTROL_MD_JSON || "{}");
const state =
  snapshot && typeof snapshot.controlState === "string"
    ? snapshot.controlState
    : "unknown";
const workerAlive =
  snapshot && typeof snapshot.workerAlive === "boolean"
    ? snapshot.workerAlive
    : null;
const processIds =
  snapshot && Array.isArray(snapshot.processIds) ? snapshot.processIds : [];
const problems =
  snapshot && Array.isArray(snapshot.problems) ? snapshot.problems : [];
const activeIssues =
  snapshot &&
  snapshot.statusSnapshot &&
  Array.isArray(snapshot.statusSnapshot.activeIssues)
    ? snapshot.statusSnapshot.activeIssues
    : [];

console.log(`- Control state: ${state}`);
console.log(
  `- Worker alive: ${workerAlive === null ? "unknown" : workerAlive ? "yes" : "no"}`,
);
console.log(
  `- Process ids: ${processIds.length === 0 ? "none" : processIds.join(", ")}`,
);
console.log(
  `- Active runtime issues: ${Array.isArray(activeIssues) ? activeIssues.length : 0}`,
);
if (problems.length === 0) {
  console.log("- Problems: none");
} else {
  console.log(`- Problems: ${problems.join(" | ")}`);
}
EOF
    echo
    echo "## Operator Summary"
    echo
    echo "- ${action_line:-ACTION: unavailable}"
    echo "- ${worker_line:-WORKER: unavailable}"
    echo "- ${issue_line:-ISSUE: unavailable}"
    echo "- ${pr_line:-PR: unavailable}"
    echo "- ${next_line:-NEXT: unavailable}"
    echo
    echo "## Ready Issues"
    echo
    READY_ISSUES_MD_JSON="${ready_issues_json}" node <<'EOF'
const items = JSON.parse(process.env.READY_ISSUES_MD_JSON || "[]");
if (items.length === 0) {
  console.log("- none");
} else {
  for (const item of items) {
    console.log(`- #${item.number} ${item.title} (${item.url})`);
  }
}
EOF
    echo
    echo "## Running Issues"
    echo
    RUNNING_ISSUES_MD_JSON="${running_issues_json}" node <<'EOF'
const items = JSON.parse(process.env.RUNNING_ISSUES_MD_JSON || "[]");
if (items.length === 0) {
  console.log("- none");
} else {
  for (const item of items) {
    console.log(`- #${item.number} ${item.title} (${item.url})`);
  }
}
EOF
    echo
    echo "## Open PRs"
    echo
    OPEN_PRS_MD_JSON="${open_prs_json}" node <<'EOF'
const items = JSON.parse(process.env.OPEN_PRS_MD_JSON || "[]");
if (items.length === 0) {
  console.log("- none");
} else {
  for (const item of items) {
    console.log(
      `- #${item.number} ${item.title} (${item.headRefName} -> ${item.baseRefName}) ${item.url}`,
    );
  }
}
EOF
  } > "${STATUS_MD_FILE}"
}

while true; do
  CYCLE_FILE="$(mktemp "${LOCK_DIR}/cycle.XXXXXX")"
  {
    echo
    echo "===== $(date -u +"%Y-%m-%dT%H:%M:%SZ") ====="
    if [[ -n "${SESSION_ID}" ]]; then
      if ! codex exec resume \
        --dangerously-bypass-approvals-and-sandbox \
        -m "${MODEL}" \
        "${SESSION_ID}" \
        "${PROMPT}"; then
        echo "Pinned session resume failed; starting a fresh Codex exec session"
        run_fresh_exec
      fi
    elif [[ "${RESUME_MODE}" == "last" ]]; then
      if ! codex exec resume \
        --dangerously-bypass-approvals-and-sandbox \
        --last \
        -m "${MODEL}" \
        "${PROMPT}"; then
        echo "Resume failed; starting a fresh Codex exec session"
        run_fresh_exec
      fi
    else
      run_fresh_exec
    fi
    echo "Cycle complete"
  } 2>&1 | tee -a "${LOG_FILE}" "${CYCLE_FILE}"

  if ! write_status_files "${CYCLE_FILE}"; then
    echo "Status file generation failed; continuing loop" | tee -a "${LOG_FILE}"
  fi
  rm -f "${CYCLE_FILE}"

  echo "Sleeping ${INTERVAL_SECONDS}s"
  sleep "${INTERVAL_SECONDS}"
done
