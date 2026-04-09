import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  prepareOperatorCycle,
  recordOperatorCycle,
} from "../runner/operator-session.js";
import {
  refreshOperatorControlState,
  type OperatorControlStateDocument,
} from "../observability/operator-control-state.js";
import {
  createEmptyOperatorReleaseState,
  readOperatorReleaseState,
  syncOperatorReleaseState,
  type OperatorReleaseStateDocument,
} from "../observability/operator-release-state.js";
import {
  readOperatorStatusSnapshot,
  writeOperatorStatusSnapshot,
  type OperatorLoopState,
  type OperatorProgressMilestone,
  type OperatorStatusSnapshot,
} from "../observability/operator-status.js";
import { promoteOperatorReadyIssues } from "../observability/operator-ready-promotion.js";
import { loadWorkflowInstancePaths } from "../config/workflow.js";
import type { OperatorRuntimeContext } from "./context.js";
import {
  acquireActiveWakeUpLease,
  acquireLoopLock,
  rejectLaunchDuringActiveWakeUpLease,
  releaseOwnedCoordinationArtifact,
  type OwnedCoordinationArtifact,
} from "./coordination.js";
import {
  assertOperatorRuntimeTransition,
  type OperatorRuntimeState,
} from "./state-machine.js";

const RECORDING_SETTLE_DELAY_MS = 1_000;
const INITIAL_CONTINUOUS_LOOP_DELAY_MS = 100;
const execFileAsync = promisify(execFile);

interface PreparedSessionState {
  readonly effectiveCommand: string;
  readonly mode: "disabled" | "fresh" | "resuming";
  readonly summary: string;
  readonly backendSessionId: string | null;
  readonly resetReason: string | null;
}

interface CurrentCycleState {
  readonly logFile: string;
  readonly startedAt: string;
}

export interface OperatorRuntimeHooks {
  readonly beforeAcquireActiveWakeUpLease?:
    | ((context: OperatorRuntimeContext) => Promise<void>)
    | undefined;
}

export async function runOperatorLoop(
  context: OperatorRuntimeContext,
  hooks: OperatorRuntimeHooks = {},
): Promise<number> {
  const runtime = new OperatorLoopRuntime(context, hooks);
  return await runtime.run();
}

class OperatorLoopRuntime {
  private runtimeState: OperatorRuntimeState = "bootstrapping";
  private loopLock: OwnedCoordinationArtifact | null = null;
  private activeWakeUpLease: OwnedCoordinationArtifact | null = null;
  private stopRequested = false;
  private sleepTimer: NodeJS.Timeout | null = null;
  private sleepResolver: (() => void) | null = null;
  private activeCommand: ChildProcessWithoutNullStreams | null = null;
  private readonly signalHandler = (signal: NodeJS.Signals) => {
    void this.handleSignal(signal);
  };

  private releaseState: OperatorReleaseStateDocument =
    createEmptyOperatorReleaseState();
  private releaseStateRefreshError: string | null = null;
  private controlState: OperatorControlStateDocument | null = null;
  private preparedSession: PreparedSessionState = {
    effectiveCommand: "",
    mode: "disabled",
    summary: "Resumable operator sessions are disabled.",
    backendSessionId: null,
    resetReason: null,
  };

  private lastCycle: {
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    logFile: string | null;
  } = {
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    logFile: null,
  };

  private nextWakeAt: string | null = null;

  constructor(
    private readonly context: OperatorRuntimeContext,
    private readonly hooks: OperatorRuntimeHooks,
  ) {
    this.preparedSession = {
      ...this.preparedSession,
      effectiveCommand: context.baseCommand,
    };
  }

  async run(): Promise<number> {
    try {
      await this.rejectNestedLaunch();
      this.warnDefaultCommand();
      await this.ensureRuntimePaths();

      this.moveTo("acquiring-loop-lock");
      this.loopLock = await acquireLoopLock({
        lockDir: this.context.lockDir,
        ownerFile: this.context.lockInfoFile,
        ownerPid: process.pid,
        repoRoot: this.context.repoRoot,
        startedAt: this.nowUtc(),
        reporter: (message) => this.emitLine(message),
      });

      process.on("SIGINT", this.signalHandler);
      process.on("SIGTERM", this.signalHandler);

      await this.writeStatus(
        "acquiring-lock",
        "Operator loop lock acquired; preparing runtime status",
      );

      if (this.context.runOnce) {
        const exitCode = await this.runCycle();
        if (this.shouldStop()) {
          if (this.runtimeState !== "stopping") {
            this.moveTo("stopping");
          }
          await this.writeStatus("idle", "Operator loop stopped");
          this.moveTo("stopped");
          return this.lastCycle.exitCode ?? exitCode;
        }
        if (exitCode === 0) {
          await this.writeStatus("idle", "Operator loop finished one cycle");
          this.moveTo("stopped");
          return 0;
        }

        await this.writeStatus(
          "idle",
          "Operator loop finished one cycle with a failure",
        );
        this.moveTo("stopped");
        return this.lastCycle.exitCode ?? 1;
      }

      this.moveTo("sleeping");
      await this.writeStatus("sleeping", "Operator loop started");
      this.emitTerminalTrace("going to sleep until the first wake-up cycle");
      await delay(INITIAL_CONTINUOUS_LOOP_DELAY_MS);

      while (!this.shouldStop()) {
        const exitCode = await this.runCycle();
        if (this.shouldStop()) {
          break;
        }

        this.nextWakeAt = this.futureUtc(this.context.intervalSeconds);
        if (exitCode === 0) {
          this.moveTo("sleeping");
          await this.writeStatus(
            "sleeping",
            "Sleeping until next operator wake-up cycle",
          );
          this.emitTerminalTrace(`going to sleep until ${this.nextWakeAt}`);
        } else {
          this.moveTo("retrying");
          await this.writeStatus(
            "retrying",
            "Cycle failed; sleeping before retrying operator loop",
          );
          this.emitTerminalTrace(
            `cycle failed; sleeping until ${this.nextWakeAt}`,
          );
        }

        await this.sleepUntilNextCycle();
        if (this.shouldStop()) {
          break;
        }
        this.moveTo("preparing-cycle");
      }

      if (this.runtimeState !== "stopping") {
        this.moveTo("stopping");
      }
      await this.writeStatus("idle", "Operator loop stopped");
      this.moveTo("stopped");
      return 0;
    } finally {
      process.off("SIGINT", this.signalHandler);
      process.off("SIGTERM", this.signalHandler);
      await releaseOwnedCoordinationArtifact(this.activeWakeUpLease);
      await releaseOwnedCoordinationArtifact(this.loopLock);
    }
  }

  private async runCycle(): Promise<number> {
    this.moveTo("preparing-cycle");
    const cycle = this.startCycle();

    try {
      await this.refreshReleaseStateNonfatal();
      if (await this.stopCycleIfRequested(cycle)) {
        return 1;
      }
      await this.runReadyPromotionNonfatal();
      if (await this.stopCycleIfRequested(cycle)) {
        return 1;
      }
      await this.prepareSession();
      if (await this.stopCycleIfRequested(cycle)) {
        return 1;
      }
      await this.refreshControlState();
      if (await this.stopCycleIfRequested(cycle)) {
        return 1;
      }
      await this.writeCycleLogHeader(cycle.logFile);
      if (await this.stopCycleIfRequested(cycle)) {
        return 1;
      }

      this.emitTerminalTrace(
        `waking up (${this.context.provider}${
          this.context.model ? `/${this.context.model}` : ""
        }; ${this.describeCycleTerminalMode()})`,
      );
      await this.writeStatus("acting", "Running operator wake-up cycle");
      if (await this.stopCycleIfRequested(cycle)) {
        return 1;
      }
      if (
        !(await this.publishProgress({
          milestone: "cycle-start",
          summary: "Wake-up cycle started.",
        }))
      ) {
        await this.handleProgressPublishFailure(
          "cycle-start",
          this.requireProgressError(),
        );
        return 1;
      }
      if (await this.stopCycleIfRequested(cycle)) {
        return 1;
      }

      this.moveTo("acquiring-active-lease");
      await this.hooks.beforeAcquireActiveWakeUpLease?.(this.context);
      const lease = await acquireActiveWakeUpLease({
        coordinationRoot: this.context.operatorCoordinationRoot,
        lockDir: this.context.activeWakeUpLockDir,
        ownerFile: this.context.activeWakeUpOwnerFile,
        ownerPid: process.pid,
        selectedInstanceRoot: this.context.selectedInstanceRoot,
        operatorRepoRoot: this.context.repoRoot,
        workflowPath: this.context.workflowPath,
        instanceKey: this.context.instanceKey,
        startedAt: this.nowUtc(),
        reporter: (message) => this.emitLine(message),
      });
      if (!lease.ok) {
        this.moveTo("recording-failure");
        await this.recordCycleFailureBeforeCommand({
          logFile: cycle.logFile,
          failureMessage: "active wake-up lease already held for this instance",
          cycleMessage:
            "Operator cycle failed before the wake-up lease could be acquired",
        });
        return 1;
      }

      this.activeWakeUpLease = lease.artifact;
      if (await this.stopCycleIfRequested(cycle)) {
        await releaseOwnedCoordinationArtifact(this.activeWakeUpLease);
        this.activeWakeUpLease = null;
        return 1;
      }
      this.moveTo("running-command");
      const exitCode = await this.executeOperatorCommand(cycle.logFile);
      await releaseOwnedCoordinationArtifact(this.activeWakeUpLease);
      this.activeWakeUpLease = null;
      if (await this.stopCycleIfRequested(cycle)) {
        return 1;
      }

      this.moveTo("post-cycle-refresh");
      this.finishCycle(exitCode);
      await this.refreshReleaseStateNonfatal();
      await this.runReadyPromotionNonfatal();
      await this.refreshControlStateNonfatal();
      if (await this.stopCycleIfRequested(cycle)) {
        return 1;
      }

      if (exitCode === 0) {
        this.moveTo("recording-success");
        const cycleMessage = "Operator cycle completed successfully";
        await this.writeStatus("recording", cycleMessage);
        if (
          !(await this.publishProgress({
            milestone: "cycle-finished",
            summary: cycleMessage,
          }))
        ) {
          await this.handleProgressPublishFailure(
            "cycle-finished",
            this.requireProgressError(),
          );
          return 1;
        }
        await this.recordCycle();
        await this.writeStatus("recording", cycleMessage);
        await delay(RECORDING_SETTLE_DELAY_MS);
        return 0;
      }

      this.moveTo("recording-failure");
      const cycleMessage = `Operator cycle failed with exit code ${exitCode.toString()}`;
      await this.writeStatus("failed", cycleMessage);
      if (
        !(await this.publishProgress({
          milestone: "cycle-failed",
          summary: cycleMessage,
        }))
      ) {
        await this.handleProgressPublishFailure(
          "cycle-failed",
          this.requireProgressError(),
        );
        return 1;
      }
      await this.recordCycle();
      await this.writeStatus("failed", cycleMessage);
      return exitCode;
    } catch (error) {
      await releaseOwnedCoordinationArtifact(this.activeWakeUpLease);
      this.activeWakeUpLease = null;
      await this.recordUnexpectedCycleFailure(cycle, error);
      return 1;
    }
  }

  private async rejectNestedLaunch(): Promise<void> {
    if (process.env.SYMPHONY_OPERATOR_ACTIVE_PARENT_LOOP === "1") {
      let message =
        "operator-loop: nested operator loop launch rejected inside an active wake-up cycle; reason=inherited-parent-loop";
      if (process.env.SYMPHONY_OPERATOR_PARENT_LOOP_PID) {
        message = `${message}; parent_pid=${process.env.SYMPHONY_OPERATOR_PARENT_LOOP_PID}`;
      }
      if (process.env.SYMPHONY_OPERATOR_PARENT_INSTANCE_KEY) {
        message = `${message}; parent_instance=${process.env.SYMPHONY_OPERATOR_PARENT_INSTANCE_KEY}`;
      }
      if (process.env.SYMPHONY_OPERATOR_PARENT_WORKFLOW_PATH) {
        message = `${message}; parent_workflow=${process.env.SYMPHONY_OPERATOR_PARENT_WORKFLOW_PATH}`;
      }
      message = `${message}; requested_instance=${this.context.instanceKey}`;
      if (this.context.workflowPath) {
        message = `${message}; requested_workflow=${this.context.workflowPath}`;
      }
      throw new Error(message);
    }

    await rejectLaunchDuringActiveWakeUpLease({
      lockDir: this.context.activeWakeUpLockDir,
      ownerFile: this.context.activeWakeUpOwnerFile,
      requestedInstanceKey: this.context.instanceKey,
      requestedWorkflowPath: this.context.workflowPath,
      reporter: (message) => this.emitLine(message),
    });
  }

  private warnDefaultCommand(): void {
    if (this.context.commandSource === "default") {
      this.emitLine(
        "operator-loop: using the default Codex command with approvals and sandbox bypass enabled",
      );
    }
  }

  private async ensureRuntimePaths(): Promise<void> {
    await fs.mkdir(this.context.logDir, { recursive: true });

    const legacyExists = await this.pathExists(
      this.context.legacyScratchpadPath,
    );
    const standingExists = await this.pathExists(
      this.context.standingContextPath,
    );
    const wakeUpExists = await this.pathExists(this.context.wakeUpLogPath);

    if (legacyExists && !standingExists && !wakeUpExists) {
      const legacyScratchpad = await fs.readFile(
        this.context.legacyScratchpadPath,
        "utf8",
      );
      await fs.writeFile(
        this.context.standingContextPath,
        [
          "# Standing Context",
          "",
          "Durable operator guidance for this selected Symphony instance belongs here.",
          "Update this file intentionally when queue policy, release sequencing, campaign",
          "notes, or known temporary workarounds change.",
          "",
          "## Migrated Legacy Scratchpad",
          "",
          "The prior `operator-scratchpad.md` content was preserved below during notebook",
          "migration. Curate the durable guidance you still need from it here.",
          "",
          legacyScratchpad.trimEnd(),
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        this.context.wakeUpLogPath,
        [
          "# Wake-Up Log",
          "",
          "Append a new timestamped entry for each operator wake-up. Keep earlier entries",
          "intact unless you are running an explicit maintenance or compaction flow.",
          "",
          "## Migration Note",
          "",
          "Legacy `operator-scratchpad.md` content was preserved in `standing-context.md`",
          "when this notebook was initialized.",
          "",
        ].join("\n"),
        "utf8",
      );
      await this.refreshReleaseStateNonfatal();
      return;
    }

    if (!standingExists) {
      await fs.writeFile(
        this.context.standingContextPath,
        [
          "# Standing Context",
          "",
          "Durable operator guidance for this selected Symphony instance belongs here.",
          "Update this file intentionally when queue policy, release sequencing, campaign",
          "notes, or known temporary workarounds change.",
          "",
        ].join("\n"),
        "utf8",
      );
    }

    if (!wakeUpExists) {
      await fs.writeFile(
        this.context.wakeUpLogPath,
        [
          "# Wake-Up Log",
          "",
          "Append a new timestamped entry for each operator wake-up. Keep earlier entries",
          "intact unless you are running an explicit maintenance or compaction flow.",
          "",
        ].join("\n"),
        "utf8",
      );
    }

    await this.refreshReleaseStateNonfatal();
  }

  private async prepareSession(): Promise<void> {
    const prepared = await prepareOperatorCycle({
      provider: this.context.provider,
      model: this.context.model,
      baseCommand: this.context.baseCommand,
      resumeSession: this.context.resumeSession,
      sessionStatePath: this.context.sessionStatePath,
    });
    this.preparedSession = {
      effectiveCommand: prepared.effectiveCommand,
      mode: prepared.sessionMode,
      summary: prepared.sessionSummary,
      backendSessionId: prepared.backendSessionId,
      resetReason: prepared.resetReason,
    };
  }

  private async recordCycle(): Promise<void> {
    if (
      this.lastCycle.startedAt === null ||
      this.lastCycle.finishedAt === null ||
      this.lastCycle.exitCode === null ||
      this.lastCycle.logFile === null
    ) {
      return;
    }

    const recorded = await recordOperatorCycle({
      provider: this.context.provider,
      model: this.context.model,
      baseCommand: this.context.baseCommand,
      resumeSession: this.context.resumeSession,
      sessionMode: this.preparedSession.mode,
      sessionStatePath: this.context.sessionStatePath,
      repoRoot: this.context.repoRoot,
      startedAt: this.lastCycle.startedAt,
      finishedAt: this.lastCycle.finishedAt,
      exitCode: this.lastCycle.exitCode,
      logFile: this.lastCycle.logFile,
      resetReason: this.preparedSession.resetReason,
    });
    this.preparedSession = {
      ...this.preparedSession,
      summary: recorded.sessionSummary,
      backendSessionId: recorded.backendSessionId,
    };
  }

  private async refreshControlState(): Promise<void> {
    this.controlState = await refreshOperatorControlState({
      workflowPath: this.context.workflowPath,
      operatorRepoRoot: this.context.repoRoot,
    });
  }

  private async refreshControlStateNonfatal(): Promise<void> {
    try {
      await this.refreshControlState();
    } catch (error) {
      this.emitLine(
        `operator-loop: failed to refresh control state: ${this.normalizeErrorOutput(error)}`,
      );
    }
  }

  private async refreshReleaseStateNonfatal(): Promise<boolean> {
    try {
      const instance = await loadWorkflowInstancePaths(
        this.context.workflowPath,
      );
      this.releaseState = await syncOperatorReleaseState({
        instance,
        releaseStateFile: this.context.releaseStatePath,
      });
      this.releaseStateRefreshError = null;
      return true;
    } catch (error) {
      this.releaseStateRefreshError = `Release state refresh failed: ${this.normalizeErrorOutput(
        error,
      )}`;
      this.emitLine(`operator-loop: ${this.releaseStateRefreshError}`);
      try {
        this.releaseState = await readOperatorReleaseState(
          this.context.releaseStatePath,
        );
      } catch {
        this.releaseState = createEmptyOperatorReleaseState();
      }
      return false;
    }
  }

  private async runReadyPromotionNonfatal(): Promise<boolean> {
    try {
      const result = await promoteOperatorReadyIssues({
        workflowPath: this.context.workflowPath,
        releaseStateFile: this.context.releaseStatePath,
      });
      this.releaseState = result.state;
      return true;
    } catch (error) {
      this.emitLine(
        `operator-loop: ready promotion failed unexpectedly: ${this.normalizeErrorOutput(
          error,
        )}`,
      );
      try {
        this.releaseState = await readOperatorReleaseState(
          this.context.releaseStatePath,
        );
      } catch {
        this.releaseState = createEmptyOperatorReleaseState();
      }
      return false;
    }
  }

  private async writeCycleLogHeader(logFile: string): Promise<void> {
    const lines = [
      "== Symphony operator cycle ==",
      `started_at=${this.lastCycle.startedAt ?? ""}`,
      `repo_root=${this.context.repoRoot}`,
      `instance_key=${this.context.instanceKey}`,
      `detached_session=${this.context.detachedSessionName}`,
      `selected_instance_root=${this.context.selectedInstanceRoot}`,
      `operator_state_root=${this.context.operatorStateRoot}`,
      `selected_workflow=${this.context.workflowPath}`,
      `control_state=${this.context.controlStatePath}`,
      `control_posture=${this.controlState?.posture ?? "runtime-blocked"}`,
      `control_summary=${
        this.controlState?.summary ?? "Operator control state is unavailable."
      }`,
      `provider=${this.context.provider}`,
      `model=${this.context.model ?? ""}`,
      `command_source=${this.context.commandSource}`,
      `base_command=${this.context.baseCommand}`,
      `effective_command=${this.preparedSession.effectiveCommand}`,
      `session_state=${this.context.sessionStatePath}`,
      `session_mode=${this.preparedSession.mode}`,
      `session_summary=${this.preparedSession.summary}`,
      `session_backend_id=${this.preparedSession.backendSessionId ?? ""}`,
      `prompt=${this.context.promptFile}`,
      "",
    ];
    await fs.appendFile(logFile, `${lines.join("\n")}\n`, "utf8");
  }

  private async recordCycleFailureBeforeCommand(args: {
    readonly logFile: string;
    readonly failureMessage: string;
    readonly cycleMessage: string;
  }): Promise<void> {
    this.finishCycle(1);
    await fs.appendFile(
      args.logFile,
      [
        `failure_at=${this.lastCycle.finishedAt ?? this.nowUtc()}`,
        `failure=${args.failureMessage}`,
      ].join("\n") + "\n",
      "utf8",
    );

    await this.writeStatus("failed", args.cycleMessage);
    if (
      !(await this.publishProgress({
        milestone: "cycle-failed",
        summary: args.cycleMessage,
      }))
    ) {
      await this.handleProgressPublishFailure(
        "cycle-failed",
        this.requireProgressError(),
      );
      return;
    }
    await this.recordCycle();
    await this.writeStatus("failed", args.cycleMessage);
  }

  private async recordUnexpectedCycleFailure(
    cycle: CurrentCycleState,
    error: unknown,
  ): Promise<void> {
    this.moveToFailureRecordingStateIfNeeded();

    this.finishCycle(1);
    const errorMessage = this.normalizeErrorOutput(error);
    await fs.appendFile(
      cycle.logFile,
      [
        `runtime_failure_at=${this.lastCycle.finishedAt ?? this.nowUtc()}`,
        `runtime_failure=${errorMessage}`,
      ].join("\n") + "\n",
      "utf8",
    );
    await this.refreshReleaseStateNonfatal();
    await this.runReadyPromotionNonfatal();
    await this.refreshControlStateNonfatal();

    const cycleMessage = `Operator cycle failed: ${errorMessage}`;
    await this.writeStatus("failed", cycleMessage);
    try {
      await this.recordCycle();
      await this.writeStatus("failed", cycleMessage);
    } catch {
      // Prefer the original cycle failure over a secondary recording error.
    }
  }

  private async stopCycleIfRequested(
    cycle: CurrentCycleState,
  ): Promise<boolean> {
    if (!this.shouldStop()) {
      return false;
    }

    await this.recordInterruptedCycle(cycle);
    return true;
  }

  private async recordInterruptedCycle(
    cycle: CurrentCycleState,
  ): Promise<void> {
    this.finishCycle(1);
    await fs.appendFile(
      cycle.logFile,
      [
        `interrupted_at=${this.lastCycle.finishedAt ?? this.nowUtc()}`,
        "interrupted=stop-requested",
      ].join("\n") + "\n",
      "utf8",
    );
    try {
      await this.recordCycle();
    } catch {
      // Best effort only while stopping.
    }
  }

  private async writeStatus(
    state: OperatorLoopState,
    message: string,
  ): Promise<void> {
    await writeOperatorStatusSnapshot(
      {
        statusJsonPath: this.context.statusJsonPath,
        statusMdPath: this.context.statusMdPath,
      },
      {
        version: 1,
        state,
        message,
        updatedAt: this.nowUtc(),
        progress: await this.readCurrentProgress(),
        repoRoot: this.context.repoRoot,
        instanceKey: this.context.instanceKey,
        detachedSessionName: this.context.detachedSessionName,
        selectedInstanceRoot: this.context.selectedInstanceRoot,
        operatorStateRoot: this.context.operatorStateRoot,
        pid: process.pid,
        runOnce: this.context.runOnce,
        intervalSeconds: this.context.intervalSeconds,
        provider: this.context.provider,
        model: this.context.model,
        commandSource: this.context.commandSource,
        command: this.context.baseCommand,
        effectiveCommand: this.preparedSession.effectiveCommand,
        promptFile: this.context.promptFile,
        operatorControl: {
          path: this.context.controlStatePath,
          posture: this.controlState?.posture ?? "runtime-blocked",
          summary:
            this.controlState?.summary ??
            "Operator control state has not been generated yet.",
          blockingCheckpoint: this.controlState?.blockingCheckpoint ?? null,
          nextActionSummary: this.controlState?.nextActionSummary ?? null,
        },
        standingContext: this.context.standingContextPath,
        wakeUpLog: this.context.wakeUpLogPath,
        operatorSession: {
          enabled: this.context.resumeSession,
          path: this.context.sessionStatePath,
          mode: this.preparedSession.mode,
          summary: this.preparedSession.summary,
          backendSessionId: this.preparedSession.backendSessionId,
          resetReason: this.preparedSession.resetReason,
        },
        releaseState: {
          path: this.context.releaseStatePath,
          releaseId: this.releaseState.configuration.releaseId,
          advancementState:
            this.releaseStateRefreshError === null
              ? this.releaseState.evaluation.advancementState
              : "unavailable",
          summary:
            this.releaseStateRefreshError ??
            this.releaseState.evaluation.summary,
          updatedAt:
            this.releaseStateRefreshError === null
              ? this.releaseState.updatedAt
              : null,
          blockingPrerequisiteNumber:
            this.releaseStateRefreshError === null
              ? (this.releaseState.evaluation.blockingPrerequisite
                  ?.issueNumber ?? null)
              : null,
          blockingPrerequisiteIdentifier:
            this.releaseStateRefreshError === null
              ? (this.releaseState.evaluation.blockingPrerequisite
                  ?.issueIdentifier ?? null)
              : null,
          promotion: {
            state: this.releaseState.promotion.state,
            summary: this.releaseState.promotion.summary,
            updatedAt: this.releaseState.promotion.promotedAt,
            eligibleIssueNumbers:
              this.releaseState.promotion.eligibleIssues.map(
                (issue) => issue.issueNumber,
              ),
            readyLabelsAdded: this.releaseState.promotion.readyLabelsAdded.map(
              (issue) => issue.issueNumber,
            ),
            readyLabelsRemoved:
              this.releaseState.promotion.readyLabelsRemoved.map(
                (issue) => issue.issueNumber,
              ),
          },
        },
        reportReviewState: this.context.reportReviewStatePath,
        selectedWorkflowPath: this.context.workflowPath,
        lastCycle: {
          startedAt: this.lastCycle.startedAt,
          finishedAt: this.lastCycle.finishedAt,
          exitCode: this.lastCycle.exitCode,
          logFile: this.lastCycle.logFile,
        },
        nextWakeAt: this.nextWakeAt,
      } satisfies OperatorStatusSnapshot,
    );
  }

  private async readCurrentProgress(): Promise<
    OperatorStatusSnapshot["progress"]
  > {
    try {
      const snapshot = await readOperatorStatusSnapshot(
        this.context.statusJsonPath,
      );
      return snapshot.progress;
    } catch {
      return null;
    }
  }

  private async publishProgress(args: {
    readonly milestone: OperatorProgressMilestone;
    readonly summary: string;
  }): Promise<boolean> {
    try {
      await this.runProgressUpdater(args);
      return true;
    } catch (error) {
      this.progressPublishError = this.extractCommandFailureMessage(error);
      this.emitLine(
        `operator-loop: failed to publish progress milestone ${args.milestone}: ${this.progressPublishError}`,
      );
      return false;
    }
  }

  private progressPublishError = "";

  private requireProgressError(): string {
    return this.progressPublishError || "unknown error";
  }

  private moveToFailureRecordingStateIfNeeded(): void {
    if (this.runtimeState === "running-command") {
      this.moveTo("post-cycle-refresh");
    }
    if (
      this.runtimeState === "preparing-cycle" ||
      this.runtimeState === "acquiring-active-lease" ||
      this.runtimeState === "post-cycle-refresh" ||
      this.runtimeState === "recording-success"
    ) {
      this.moveTo("recording-failure");
    }
  }

  private async handleProgressPublishFailure(
    milestone: OperatorProgressMilestone,
    errorMessage: string,
  ): Promise<void> {
    const cycleMessage = `Operator cycle failed while publishing progress milestone ${milestone}: ${errorMessage}`;
    this.emitTerminalTrace(cycleMessage);
    if (this.lastCycle.logFile !== null) {
      await fs.appendFile(
        this.lastCycle.logFile,
        [
          `progress_publish_failure_at=${this.nowUtc()}`,
          `progress_publish_failure_milestone=${milestone}`,
          `progress_publish_failure=${errorMessage}`,
        ].join("\n") + "\n",
        "utf8",
      );
    }

    if (this.lastCycle.finishedAt === null) {
      this.lastCycle = {
        ...this.lastCycle,
        finishedAt: this.nowUtc(),
      };
    }
    if (this.lastCycle.exitCode === null || this.lastCycle.exitCode === 0) {
      this.lastCycle = {
        ...this.lastCycle,
        exitCode: 1,
      };
    }
    this.moveToFailureRecordingStateIfNeeded();

    if (
      this.lastCycle.startedAt !== null &&
      this.lastCycle.finishedAt !== null &&
      this.lastCycle.logFile !== null
    ) {
      await this.recordCycle();
    }
    await this.writeStatus("failed", cycleMessage);
  }

  private async executeOperatorCommand(logFile: string): Promise<number> {
    const logStream = createWriteStream(logFile, { flags: "a" });
    const child = spawn(
      "bash",
      ["-l", "-c", this.preparedSession.effectiveCommand],
      {
        cwd: this.context.repoRoot,
        env: this.buildOperatorCommandEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.activeCommand = child;

    const stdin = createReadStream(this.context.promptFile);
    stdin.on("error", (error) => {
      child.stdin.destroy(error);
    });
    stdin.pipe(child.stdin);
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });

    try {
      const [exitCode, signal] = (await once(child, "close")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      await new Promise<void>((resolve) => {
        logStream.end(() => resolve());
      });
      this.activeCommand = null;
      return exitCode ?? (signal === null ? 1 : 1);
    } catch (error) {
      this.activeCommand = null;
      await new Promise<void>((resolve) => {
        logStream.end(() => resolve());
      });
      throw error;
    }
  }

  private async runProgressUpdater(args: {
    readonly milestone: OperatorProgressMilestone;
    readonly summary: string;
  }): Promise<void> {
    const commandArgs = [
      this.context.progressUpdaterPath,
      "--status-json",
      this.context.statusJsonPath,
      "--status-md",
      this.context.statusMdPath,
      "--milestone",
      args.milestone,
      "--summary",
      args.summary,
    ];
    const localTsxPath = path.join(
      this.context.repoRoot,
      "node_modules/.bin/tsx",
    );

    if (await this.pathExists(localTsxPath)) {
      await execFileAsync(localTsxPath, commandArgs, {
        cwd: this.context.repoRoot,
        env: process.env,
      });
      return;
    }

    await execFileAsync("pnpm", ["tsx", ...commandArgs], {
      cwd: this.context.repoRoot,
      env: process.env,
    });
  }

  private buildOperatorCommandEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      SYMPHONY_OPERATOR_ACTIVE_PARENT_LOOP: "1",
      SYMPHONY_OPERATOR_PARENT_LOOP_PID: process.pid.toString(),
      SYMPHONY_OPERATOR_PARENT_INSTANCE_KEY: this.context.instanceKey,
      SYMPHONY_OPERATOR_PARENT_REPO_ROOT: this.context.repoRoot,
      SYMPHONY_OPERATOR_PARENT_SELECTED_INSTANCE_ROOT:
        this.context.selectedInstanceRoot,
      SYMPHONY_OPERATOR_PARENT_WORKFLOW_PATH: this.context.workflowPath,
      SYMPHONY_OPERATOR_REPO_ROOT: this.context.repoRoot,
      SYMPHONY_OPERATOR_INSTANCE_KEY: this.context.instanceKey,
      SYMPHONY_OPERATOR_DETACHED_SESSION_NAME: this.context.detachedSessionName,
      SYMPHONY_OPERATOR_SELECTED_INSTANCE_ROOT:
        this.context.selectedInstanceRoot,
      SYMPHONY_OPERATOR_STATE_ROOT: this.context.operatorStateRoot,
      SYMPHONY_OPERATOR_STANDING_CONTEXT: this.context.standingContextPath,
      SYMPHONY_OPERATOR_WAKE_UP_LOG: this.context.wakeUpLogPath,
      SYMPHONY_OPERATOR_LEGACY_SCRATCHPAD: this.context.legacyScratchpadPath,
      SYMPHONY_OPERATOR_CONTROL_STATE: this.context.controlStatePath,
      SYMPHONY_OPERATOR_CONTROL_POSTURE:
        this.controlState?.posture ?? "runtime-blocked",
      SYMPHONY_OPERATOR_CONTROL_SUMMARY:
        this.controlState?.summary ?? "Operator control state is unavailable.",
      SYMPHONY_OPERATOR_RELEASE_STATE: this.context.releaseStatePath,
      SYMPHONY_OPERATOR_STATUS_JSON: this.context.statusJsonPath,
      SYMPHONY_OPERATOR_STATUS_MD: this.context.statusMdPath,
      SYMPHONY_OPERATOR_PROGRESS_UPDATER: this.context.progressUpdaterPath,
      SYMPHONY_OPERATOR_LOG_DIR: this.context.logDir,
      SYMPHONY_OPERATOR_PROMPT_FILE: this.context.promptFile,
      SYMPHONY_OPERATOR_WORKFLOW_PATH: this.context.workflowPath,
      SYMPHONY_OPERATOR_REPORT_REVIEW_STATE: this.context.reportReviewStatePath,
      SYMPHONY_OPERATOR_SESSION_STATE: this.context.sessionStatePath,
      SYMPHONY_OPERATOR_PROVIDER: this.context.provider,
      SYMPHONY_OPERATOR_MODEL: this.context.model ?? "",
      SYMPHONY_OPERATOR_COMMAND_SOURCE: this.context.commandSource,
      SYMPHONY_OPERATOR_BASE_COMMAND: this.context.baseCommand,
      SYMPHONY_OPERATOR_EFFECTIVE_COMMAND:
        this.preparedSession.effectiveCommand,
      SYMPHONY_OPERATOR_SESSION_MODE: this.preparedSession.mode,
    };
  }

  private async handleSignal(signal: NodeJS.Signals): Promise<void> {
    const firstStopRequest = !this.stopRequested;
    this.stopRequested = true;
    if (this.sleepTimer !== null) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.sleepResolver?.();
    this.sleepResolver = null;

    if (this.activeCommand !== null && this.activeCommand.exitCode === null) {
      this.activeCommand.kill(signal);
    }

    if (!firstStopRequest) {
      return;
    }

    try {
      await this.writeStatus(
        "stopping",
        "Signal received; stopping operator loop",
      );
    } catch {
      // Best effort only during signal handling.
    }
  }

  private async sleepUntilNextCycle(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.sleepResolver = resolve;
      this.sleepTimer = setTimeout(
        resolve,
        this.context.intervalSeconds * 1000,
      );
    });
    if (this.sleepTimer !== null) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.sleepResolver = null;
  }

  private startCycle(): CurrentCycleState {
    const startedAt = this.nowUtc();
    const timestamp = startedAt
      .replace(/[-:]/gu, "")
      .replace(/\.\d{3}Z$/u, "Z");
    const logFile = `${this.context.logDir}/operator-cycle-${timestamp}.log`;
    this.lastCycle = {
      startedAt,
      finishedAt: null,
      exitCode: null,
      logFile,
    };
    this.nextWakeAt = null;
    return {
      logFile,
      startedAt,
    };
  }

  private finishCycle(exitCode: number): void {
    this.lastCycle = {
      ...this.lastCycle,
      finishedAt: this.nowUtc(),
      exitCode,
    };
  }

  private describeCycleTerminalMode(): string {
    switch (this.preparedSession.mode) {
      case "resuming":
        return this.preparedSession.backendSessionId === null
          ? "resuming"
          : `resuming from ${this.preparedSession.backendSessionId}`;
      case "fresh":
        return "starting fresh";
      case "disabled":
        return "disabled";
      default:
        return this.preparedSession.mode;
    }
  }

  private nowUtc(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  }

  private futureUtc(intervalSeconds: number): string {
    return new Date(Date.now() + intervalSeconds * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/u, "Z");
  }

  private emitTerminalTrace(message: string): void {
    this.emitLine(`[${this.nowUtc()}] operator-loop: ${message}`);
  }

  private emitLine(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  private shouldStop(): boolean {
    return this.stopRequested;
  }

  private normalizeErrorOutput(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message
      .replace(/[\r\n]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private extractCommandFailureMessage(error: unknown): string {
    if (
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof (error as { stderr?: unknown }).stderr === "string"
    ) {
      const stderr = (error as { stderr: string }).stderr;
      const normalized = stderr
        .replace(/[\r\n]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
    return this.normalizeErrorOutput(error);
  }

  private moveTo(next: OperatorRuntimeState): void {
    if (this.runtimeState === next) {
      return;
    }
    assertOperatorRuntimeTransition({
      from: this.runtimeState,
      to: next,
    });
    this.runtimeState = next;
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
