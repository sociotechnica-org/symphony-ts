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
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("state" in parsed) ||
    typeof parsed.state !== "string" ||
    !("message" in parsed) ||
    typeof parsed.message !== "string" ||
    !("updatedAt" in parsed) ||
    typeof parsed.updatedAt !== "string"
  ) {
    throw new Error(`Malformed operator status snapshot at ${filePath}`);
  }
  return parsed as OperatorStatusSnapshot;
}

export function advanceOperatorStatusProgress(args: {
  readonly current: OperatorStatusProgressSnapshot | null;
  readonly update: OperatorStatusProgressUpdate;
}): OperatorStatusProgressSnapshot {
  const updatedAt = args.update.updatedAt ?? new Date().toISOString();
  return {
    milestone: args.update.milestone,
    summary: args.update.summary,
    updatedAt,
    sequence: (args.current?.sequence ?? 0) + 1,
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
