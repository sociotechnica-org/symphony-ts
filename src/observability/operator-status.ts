import fs from "node:fs/promises";
import { writeJsonFileAtomic, writeTextFileAtomic } from "./atomic-file.js";

export const OPERATOR_STATUS_SCHEMA_VERSION = 1 as const;

export type OperatorLoopState =
  | "acquiring-lock"
  | "sleeping"
  | "acting"
  | "recording"
  | "idle"
  | "retrying"
  | "failed"
  | "stopping";

export type OperatorProgressMilestone =
  | "cycle-start"
  | "checkpoint-runtime"
  | "checkpoint-report-review"
  | "checkpoint-release"
  | "checkpoint-actions"
  | "landing-issued"
  | "post-landing-follow-through"
  | "post-merge-refresh"
  | "wake-up-log"
  | "cycle-finished"
  | "cycle-failed";

const validOperatorLoopStates = new Set<OperatorLoopState>([
  "acquiring-lock",
  "sleeping",
  "acting",
  "recording",
  "idle",
  "retrying",
  "failed",
  "stopping",
]);

const validOperatorProgressMilestones = new Set<OperatorProgressMilestone>([
  "cycle-start",
  "checkpoint-runtime",
  "checkpoint-report-review",
  "checkpoint-release",
  "checkpoint-actions",
  "landing-issued",
  "post-landing-follow-through",
  "post-merge-refresh",
  "wake-up-log",
  "cycle-finished",
  "cycle-failed",
]);

export interface OperatorStatusProgressSnapshot {
  readonly milestone: OperatorProgressMilestone;
  readonly summary: string;
  readonly updatedAt: string;
  readonly sequence: number;
  readonly relatedIssueNumber: number | null;
  readonly relatedIssueIdentifier: string | null;
  readonly relatedPullRequestNumber: number | null;
  readonly previousMilestone: OperatorProgressMilestone | null;
  readonly previousSummary: string | null;
  readonly previousUpdatedAt: string | null;
}

export interface OperatorStatusSnapshot {
  readonly version: typeof OPERATOR_STATUS_SCHEMA_VERSION;
  readonly state: OperatorLoopState;
  readonly message: string;
  readonly updatedAt: string;
  readonly progress: OperatorStatusProgressSnapshot | null;
  readonly repoRoot: string;
  readonly instanceKey: string;
  readonly detachedSessionName: string;
  readonly selectedInstanceRoot: string;
  readonly operatorStateRoot: string;
  readonly pid: number;
  readonly runOnce: boolean;
  readonly intervalSeconds: number;
  readonly provider: string;
  readonly model: string | null;
  readonly commandSource: string;
  readonly command: string;
  readonly effectiveCommand: string;
  readonly promptFile: string;
  readonly operatorControl: {
    readonly path: string;
    readonly posture: string;
    readonly summary: string;
    readonly blockingCheckpoint: string | null;
    readonly nextActionSummary: string | null;
  };
  readonly standingContext: string;
  readonly wakeUpLog: string;
  readonly operatorSession: {
    readonly enabled: boolean;
    readonly path: string;
    readonly mode: string;
    readonly summary: string;
    readonly backendSessionId: string | null;
    readonly resetReason: string | null;
  };
  readonly releaseState: {
    readonly path: string;
    readonly releaseId: string | null;
    readonly advancementState: string;
    readonly summary: string;
    readonly updatedAt: string | null;
    readonly blockingPrerequisiteNumber: number | null;
    readonly blockingPrerequisiteIdentifier: string | null;
    readonly promotion: {
      readonly state: string;
      readonly summary: string;
      readonly updatedAt: string | null;
      readonly eligibleIssueNumbers: readonly number[];
      readonly readyLabelsAdded: readonly number[];
      readonly readyLabelsRemoved: readonly number[];
    };
  };
  readonly reportReviewState: string;
  readonly selectedWorkflowPath: string | null;
  readonly lastCycle: {
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly exitCode: number | null;
    readonly logFile: string | null;
  };
  readonly nextWakeAt: string | null;
}

export interface OperatorStatusProgressUpdate {
  readonly milestone: OperatorProgressMilestone;
  readonly summary: string;
  readonly updatedAt?: string | undefined;
  readonly relatedIssueNumber?: number | null | undefined;
  readonly relatedIssueIdentifier?: string | null | undefined;
  readonly relatedPullRequestNumber?: number | null | undefined;
}

export interface OperatorStatusPaths {
  readonly statusJsonPath: string;
  readonly statusMdPath: string;
}

function nullable(value: string | null | undefined, fallback = "n/a"): string {
  return value ?? fallback;
}

function renderNumberList(values: readonly number[]): string {
  return values.length === 0
    ? "none"
    : values.map((value) => value.toString()).join(",");
}

function renderProgressRelation(
  progress: OperatorStatusProgressSnapshot | null,
): string {
  if (progress === null) {
    return "none";
  }
  const issue =
    progress.relatedIssueIdentifier ??
    (progress.relatedIssueNumber === null
      ? null
      : `#${progress.relatedIssueNumber.toString()}`);
  const pullRequest =
    progress.relatedPullRequestNumber === null
      ? null
      : `PR #${progress.relatedPullRequestNumber.toString()}`;
  if (issue === null && pullRequest === null) {
    return "none";
  }
  return [issue, pullRequest].filter((value) => value !== null).join(" / ");
}

function expectRecord(
  value: unknown,
  filePath: string,
  fieldPath: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Malformed ${fieldPath} in operator status snapshot at ${filePath}`,
    );
  }
  return value as Record<string, unknown>;
}

function expectString(
  value: unknown,
  filePath: string,
  fieldPath: string,
): string {
  if (typeof value !== "string") {
    throw new Error(
      `Malformed ${fieldPath} in operator status snapshot at ${filePath}`,
    );
  }
  return value;
}

function expectNullableString(
  value: unknown,
  filePath: string,
  fieldPath: string,
): string | null {
  if (value === null) {
    return null;
  }
  return expectString(value, filePath, fieldPath);
}

function expectBoolean(
  value: unknown,
  filePath: string,
  fieldPath: string,
): boolean {
  if (typeof value !== "boolean") {
    throw new Error(
      `Malformed ${fieldPath} in operator status snapshot at ${filePath}`,
    );
  }
  return value;
}

function expectInteger(
  value: unknown,
  filePath: string,
  fieldPath: string,
): number {
  if (!Number.isInteger(value)) {
    throw new Error(
      `Malformed ${fieldPath} in operator status snapshot at ${filePath}`,
    );
  }
  return value as number;
}

function expectNullableInteger(
  value: unknown,
  filePath: string,
  fieldPath: string,
): number | null {
  if (value === null) {
    return null;
  }
  return expectInteger(value, filePath, fieldPath);
}

function expectIntegerArray(
  value: unknown,
  filePath: string,
  fieldPath: string,
): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => !Number.isInteger(entry))
  ) {
    throw new Error(
      `Malformed ${fieldPath} in operator status snapshot at ${filePath}`,
    );
  }
  return value as readonly number[];
}

function parseOperatorLoopState(
  value: unknown,
  filePath: string,
  fieldPath: string,
): OperatorLoopState {
  const state = expectString(value, filePath, fieldPath);
  if (!validOperatorLoopStates.has(state as OperatorLoopState)) {
    throw new Error(
      `Malformed ${fieldPath} in operator status snapshot at ${filePath}`,
    );
  }
  return state as OperatorLoopState;
}

function parseOperatorProgressMilestone(
  value: unknown,
  filePath: string,
  fieldPath: string,
): OperatorProgressMilestone {
  const milestone = expectString(value, filePath, fieldPath);
  if (
    !validOperatorProgressMilestones.has(milestone as OperatorProgressMilestone)
  ) {
    throw new Error(
      `Malformed ${fieldPath} in operator status snapshot at ${filePath}`,
    );
  }
  return milestone as OperatorProgressMilestone;
}

function parseOperatorStatusProgressSnapshot(
  value: unknown,
  filePath: string,
): OperatorStatusProgressSnapshot | null {
  if (value === null) {
    return null;
  }
  const progress = expectRecord(value, filePath, "progress");
  return {
    milestone: parseOperatorProgressMilestone(
      progress.milestone,
      filePath,
      "progress.milestone",
    ),
    summary: expectString(progress.summary, filePath, "progress.summary"),
    updatedAt: expectString(progress.updatedAt, filePath, "progress.updatedAt"),
    sequence: expectInteger(progress.sequence, filePath, "progress.sequence"),
    relatedIssueNumber: expectNullableInteger(
      progress.relatedIssueNumber,
      filePath,
      "progress.relatedIssueNumber",
    ),
    relatedIssueIdentifier: expectNullableString(
      progress.relatedIssueIdentifier,
      filePath,
      "progress.relatedIssueIdentifier",
    ),
    relatedPullRequestNumber: expectNullableInteger(
      progress.relatedPullRequestNumber,
      filePath,
      "progress.relatedPullRequestNumber",
    ),
    previousMilestone:
      progress.previousMilestone === null
        ? null
        : parseOperatorProgressMilestone(
            progress.previousMilestone,
            filePath,
            "progress.previousMilestone",
          ),
    previousSummary: expectNullableString(
      progress.previousSummary,
      filePath,
      "progress.previousSummary",
    ),
    previousUpdatedAt: expectNullableString(
      progress.previousUpdatedAt,
      filePath,
      "progress.previousUpdatedAt",
    ),
  };
}

function parseOperatorStatusSnapshot(
  value: unknown,
  filePath: string,
): OperatorStatusSnapshot {
  const snapshot = expectRecord(value, filePath, "root");
  const operatorControl = expectRecord(
    snapshot.operatorControl,
    filePath,
    "operatorControl",
  );
  const operatorSession = expectRecord(
    snapshot.operatorSession,
    filePath,
    "operatorSession",
  );
  const releaseState = expectRecord(
    snapshot.releaseState,
    filePath,
    "releaseState",
  );
  const releasePromotion = expectRecord(
    releaseState.promotion,
    filePath,
    "releaseState.promotion",
  );
  const lastCycle = expectRecord(snapshot.lastCycle, filePath, "lastCycle");

  const version = expectInteger(snapshot.version, filePath, "version");
  if (version !== OPERATOR_STATUS_SCHEMA_VERSION) {
    throw new Error(
      `Malformed version in operator status snapshot at ${filePath}`,
    );
  }

  return {
    version: OPERATOR_STATUS_SCHEMA_VERSION,
    state: parseOperatorLoopState(snapshot.state, filePath, "state"),
    message: expectString(snapshot.message, filePath, "message"),
    updatedAt: expectString(snapshot.updatedAt, filePath, "updatedAt"),
    progress: parseOperatorStatusProgressSnapshot(snapshot.progress, filePath),
    repoRoot: expectString(snapshot.repoRoot, filePath, "repoRoot"),
    instanceKey: expectString(snapshot.instanceKey, filePath, "instanceKey"),
    detachedSessionName: expectString(
      snapshot.detachedSessionName,
      filePath,
      "detachedSessionName",
    ),
    selectedInstanceRoot: expectString(
      snapshot.selectedInstanceRoot,
      filePath,
      "selectedInstanceRoot",
    ),
    operatorStateRoot: expectString(
      snapshot.operatorStateRoot,
      filePath,
      "operatorStateRoot",
    ),
    pid: expectInteger(snapshot.pid, filePath, "pid"),
    runOnce: expectBoolean(snapshot.runOnce, filePath, "runOnce"),
    intervalSeconds: expectInteger(
      snapshot.intervalSeconds,
      filePath,
      "intervalSeconds",
    ),
    provider: expectString(snapshot.provider, filePath, "provider"),
    model: expectNullableString(snapshot.model, filePath, "model"),
    commandSource: expectString(
      snapshot.commandSource,
      filePath,
      "commandSource",
    ),
    command: expectString(snapshot.command, filePath, "command"),
    effectiveCommand: expectString(
      snapshot.effectiveCommand,
      filePath,
      "effectiveCommand",
    ),
    promptFile: expectString(snapshot.promptFile, filePath, "promptFile"),
    operatorControl: {
      path: expectString(
        operatorControl.path,
        filePath,
        "operatorControl.path",
      ),
      posture: expectString(
        operatorControl.posture,
        filePath,
        "operatorControl.posture",
      ),
      summary: expectString(
        operatorControl.summary,
        filePath,
        "operatorControl.summary",
      ),
      blockingCheckpoint: expectNullableString(
        operatorControl.blockingCheckpoint,
        filePath,
        "operatorControl.blockingCheckpoint",
      ),
      nextActionSummary: expectNullableString(
        operatorControl.nextActionSummary,
        filePath,
        "operatorControl.nextActionSummary",
      ),
    },
    standingContext: expectString(
      snapshot.standingContext,
      filePath,
      "standingContext",
    ),
    wakeUpLog: expectString(snapshot.wakeUpLog, filePath, "wakeUpLog"),
    operatorSession: {
      enabled: expectBoolean(
        operatorSession.enabled,
        filePath,
        "operatorSession.enabled",
      ),
      path: expectString(
        operatorSession.path,
        filePath,
        "operatorSession.path",
      ),
      mode: expectString(
        operatorSession.mode,
        filePath,
        "operatorSession.mode",
      ),
      summary: expectString(
        operatorSession.summary,
        filePath,
        "operatorSession.summary",
      ),
      backendSessionId: expectNullableString(
        operatorSession.backendSessionId,
        filePath,
        "operatorSession.backendSessionId",
      ),
      resetReason: expectNullableString(
        operatorSession.resetReason,
        filePath,
        "operatorSession.resetReason",
      ),
    },
    releaseState: {
      path: expectString(releaseState.path, filePath, "releaseState.path"),
      releaseId: expectNullableString(
        releaseState.releaseId,
        filePath,
        "releaseState.releaseId",
      ),
      advancementState: expectString(
        releaseState.advancementState,
        filePath,
        "releaseState.advancementState",
      ),
      summary: expectString(
        releaseState.summary,
        filePath,
        "releaseState.summary",
      ),
      updatedAt: expectNullableString(
        releaseState.updatedAt,
        filePath,
        "releaseState.updatedAt",
      ),
      blockingPrerequisiteNumber: expectNullableInteger(
        releaseState.blockingPrerequisiteNumber,
        filePath,
        "releaseState.blockingPrerequisiteNumber",
      ),
      blockingPrerequisiteIdentifier: expectNullableString(
        releaseState.blockingPrerequisiteIdentifier,
        filePath,
        "releaseState.blockingPrerequisiteIdentifier",
      ),
      promotion: {
        state: expectString(
          releasePromotion.state,
          filePath,
          "releaseState.promotion.state",
        ),
        summary: expectString(
          releasePromotion.summary,
          filePath,
          "releaseState.promotion.summary",
        ),
        updatedAt: expectNullableString(
          releasePromotion.updatedAt,
          filePath,
          "releaseState.promotion.updatedAt",
        ),
        eligibleIssueNumbers: expectIntegerArray(
          releasePromotion.eligibleIssueNumbers,
          filePath,
          "releaseState.promotion.eligibleIssueNumbers",
        ),
        readyLabelsAdded: expectIntegerArray(
          releasePromotion.readyLabelsAdded,
          filePath,
          "releaseState.promotion.readyLabelsAdded",
        ),
        readyLabelsRemoved: expectIntegerArray(
          releasePromotion.readyLabelsRemoved,
          filePath,
          "releaseState.promotion.readyLabelsRemoved",
        ),
      },
    },
    reportReviewState: expectString(
      snapshot.reportReviewState,
      filePath,
      "reportReviewState",
    ),
    selectedWorkflowPath: expectNullableString(
      snapshot.selectedWorkflowPath,
      filePath,
      "selectedWorkflowPath",
    ),
    lastCycle: {
      startedAt: expectNullableString(
        lastCycle.startedAt,
        filePath,
        "lastCycle.startedAt",
      ),
      finishedAt: expectNullableString(
        lastCycle.finishedAt,
        filePath,
        "lastCycle.finishedAt",
      ),
      exitCode: expectNullableInteger(
        lastCycle.exitCode,
        filePath,
        "lastCycle.exitCode",
      ),
      logFile: expectNullableString(
        lastCycle.logFile,
        filePath,
        "lastCycle.logFile",
      ),
    },
    nextWakeAt: expectNullableString(
      snapshot.nextWakeAt,
      filePath,
      "nextWakeAt",
    ),
  };
}

export function renderOperatorStatusSnapshot(
  snapshot: OperatorStatusSnapshot,
): string {
  return [
    "# Symphony Operator Loop",
    "",
    `- State: ${snapshot.state}`,
    `- Message: ${snapshot.message}`,
    `- Updated: ${snapshot.updatedAt}`,
    `- Progress milestone: ${snapshot.progress?.milestone ?? "none"}`,
    `- Progress summary: ${snapshot.progress?.summary ?? "No cycle progress has been published yet."}`,
    `- Progress updated: ${snapshot.progress?.updatedAt ?? "n/a"}`,
    `- Progress sequence: ${snapshot.progress?.sequence.toString() ?? "n/a"}`,
    `- Progress subject: ${renderProgressRelation(snapshot.progress)}`,
    `- Previous progress milestone: ${snapshot.progress?.previousMilestone ?? "none"}`,
    `- Previous progress summary: ${snapshot.progress?.previousSummary ?? "n/a"}`,
    `- Previous progress updated: ${snapshot.progress?.previousUpdatedAt ?? "n/a"}`,
    `- Repo root: ${snapshot.repoRoot}`,
    `- Instance key: ${snapshot.instanceKey}`,
    `- Detached session: ${snapshot.detachedSessionName}`,
    `- Selected instance root: ${snapshot.selectedInstanceRoot}`,
    `- Operator state root: ${snapshot.operatorStateRoot}`,
    `- Mode: ${snapshot.runOnce ? "once" : "continuous"}`,
    `- Interval seconds: ${snapshot.intervalSeconds.toString()}`,
    `- Selected workflow: ${snapshot.selectedWorkflowPath ?? "n/a"}`,
    `- Provider: ${snapshot.provider}`,
    `- Model: ${snapshot.model ?? "default"}`,
    `- Command source: ${snapshot.commandSource}`,
    `- Base command: ${snapshot.command}`,
    `- Effective command: ${snapshot.effectiveCommand}`,
    `- Resumable session enabled: ${snapshot.operatorSession.enabled ? "true" : "false"}`,
    `- Session state: ${snapshot.operatorSession.path}`,
    `- Session mode: ${snapshot.operatorSession.mode}`,
    `- Session summary: ${snapshot.operatorSession.summary}`,
    `- Session backend id: ${snapshot.operatorSession.backendSessionId ?? "n/a"}`,
    `- Session reset reason: ${snapshot.operatorSession.resetReason ?? "n/a"}`,
    `- Standing context: ${snapshot.standingContext}`,
    `- Wake-up log: ${snapshot.wakeUpLog}`,
    `- Release state: ${snapshot.releaseState.path}`,
    `- Release advancement state: ${snapshot.releaseState.advancementState}`,
    `- Release summary: ${snapshot.releaseState.summary}`,
    `- Release blocked by prerequisite: ${
      snapshot.releaseState.blockingPrerequisiteIdentifier ??
      snapshot.releaseState.blockingPrerequisiteNumber?.toString() ??
      "n/a"
    }`,
    `- Ready promotion state: ${snapshot.releaseState.promotion.state}`,
    `- Ready promotion summary: ${snapshot.releaseState.promotion.summary}`,
    `- Ready promotion eligible issues: ${renderNumberList(snapshot.releaseState.promotion.eligibleIssueNumbers)}`,
    `- Ready promotion added: ${renderNumberList(snapshot.releaseState.promotion.readyLabelsAdded)}`,
    `- Ready promotion removed: ${renderNumberList(snapshot.releaseState.promotion.readyLabelsRemoved)}`,
    `- Report review state: ${snapshot.reportReviewState}`,
    `- Prompt: ${snapshot.promptFile}`,
    `- Operator control state: ${snapshot.operatorControl.path}`,
    `- Operator control posture: ${snapshot.operatorControl.posture}`,
    `- Operator control summary: ${snapshot.operatorControl.summary}`,
    `- Operator control blocking checkpoint: ${
      snapshot.operatorControl.blockingCheckpoint ?? "none"
    }`,
    `- Operator control next action: ${
      snapshot.operatorControl.nextActionSummary ?? "n/a"
    }`,
    `- Last cycle started: ${nullable(snapshot.lastCycle.startedAt)}`,
    `- Last cycle finished: ${nullable(snapshot.lastCycle.finishedAt)}`,
    `- Last cycle exit code: ${
      snapshot.lastCycle.exitCode === null
        ? "n/a"
        : snapshot.lastCycle.exitCode.toString()
    }`,
    `- Last cycle log: ${nullable(snapshot.lastCycle.logFile)}`,
    `- Next wake: ${nullable(snapshot.nextWakeAt)}`,
  ].join("\n");
}

export async function writeOperatorStatusSnapshot(
  paths: OperatorStatusPaths,
  snapshot: OperatorStatusSnapshot,
): Promise<void> {
  await writeJsonFileAtomic(paths.statusJsonPath, snapshot, {
    tempPrefix: ".operator-status",
  });
  await writeTextFileAtomic(
    paths.statusMdPath,
    `${renderOperatorStatusSnapshot(snapshot)}\n`,
    {
      tempPrefix: ".operator-status",
    },
  );
}

export async function readOperatorStatusSnapshot(
  filePath: string,
): Promise<OperatorStatusSnapshot> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Failed to parse operator status snapshot at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseOperatorStatusSnapshot(parsed, filePath);
}

export function advanceOperatorStatusProgress(args: {
  readonly current: OperatorStatusProgressSnapshot | null;
  readonly update: OperatorStatusProgressUpdate;
}): OperatorStatusProgressSnapshot {
  const updatedAt = args.update.updatedAt ?? new Date().toISOString();
  const sequence =
    args.update.milestone === "cycle-start"
      ? 1
      : (args.current?.sequence ?? 0) + 1;
  return {
    milestone: args.update.milestone,
    summary: args.update.summary,
    updatedAt,
    sequence,
    relatedIssueNumber: args.update.relatedIssueNumber ?? null,
    relatedIssueIdentifier: args.update.relatedIssueIdentifier ?? null,
    relatedPullRequestNumber: args.update.relatedPullRequestNumber ?? null,
    previousMilestone: args.current?.milestone ?? null,
    previousSummary: args.current?.summary ?? null,
    previousUpdatedAt: args.current?.updatedAt ?? null,
  };
}

export async function updateOperatorStatusProgress(
  paths: OperatorStatusPaths,
  update: OperatorStatusProgressUpdate,
): Promise<OperatorStatusSnapshot> {
  const snapshot = await readOperatorStatusSnapshot(paths.statusJsonPath);
  const nextUpdatedAt = update.updatedAt ?? new Date().toISOString();
  const nextSnapshot: OperatorStatusSnapshot = {
    ...snapshot,
    updatedAt: nextUpdatedAt,
    progress: advanceOperatorStatusProgress({
      current: snapshot.progress,
      update: {
        ...update,
        updatedAt: nextUpdatedAt,
      },
    }),
  };
  await writeOperatorStatusSnapshot(paths, nextSnapshot);
  return nextSnapshot;
}
