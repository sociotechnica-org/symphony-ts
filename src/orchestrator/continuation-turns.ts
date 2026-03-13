import type { HandoffLifecycle } from "../domain/handoff.js";
import type { RuntimeIssue } from "../domain/issue.js";
import type { RunSession, RunTurn } from "../domain/run.js";
import type { PromptBuilder } from "../domain/workflow.js";
import type { RunnerSessionDescription } from "../runner/service.js";

export interface RunSessionArtifactsState {
  readonly runSession: RunSession;
  readonly description: RunnerSessionDescription;
  readonly latestTurnNumber: number | null;
}

export async function createContinuationRunTurn(input: {
  readonly initialPrompt: string;
  readonly promptBuilder: PromptBuilder;
  readonly issue: RuntimeIssue;
  readonly pullRequest: HandoffLifecycle | null;
  readonly turnNumber: number;
  readonly maxTurns: number;
}): Promise<RunTurn> {
  return {
    turnNumber: input.turnNumber,
    prompt:
      input.turnNumber === 1
        ? input.initialPrompt
        : await input.promptBuilder.buildContinuation({
            issue: input.issue,
            turnNumber: input.turnNumber,
            maxTurns: input.maxTurns,
            pullRequest: input.pullRequest,
          }),
  };
}

export function shouldContinueTurnLoop(
  lifecycle: HandoffLifecycle,
  turnNumber: number,
  maxTurns: number,
): boolean {
  if (turnNumber >= maxTurns) {
    return false;
  }
  return (
    lifecycle.kind === "rework-required" || lifecycle.kind === "missing-target"
  );
}

function buildMaxTurnsSummary(
  lifecycle: HandoffLifecycle,
  maxTurns: number,
): string {
  return `Reached agent.max_turns (${maxTurns.toString()}) with remaining ${lifecycle.kind} work: ${lifecycle.summary}`;
}

export function summarizeLifecycleTurnBudgetFailure(
  lifecycle: HandoffLifecycle,
  latestTurnNumber: number | null,
  maxTurns: number,
): string {
  if (
    (lifecycle.kind !== "rework-required" &&
      lifecycle.kind !== "missing-target") ||
    latestTurnNumber !== maxTurns
  ) {
    return lifecycle.summary;
  }
  return summarizeTurnBudgetExhaustion(lifecycle, maxTurns);
}

export function summarizeMissingTargetFailure(
  lifecycle: HandoffLifecycle,
  maxTurns: number,
): string {
  return summarizeTurnBudgetExhaustion(lifecycle, maxTurns);
}

function summarizeTurnBudgetExhaustion(
  lifecycle: HandoffLifecycle,
  maxTurns: number,
): string {
  if (maxTurns <= 1) {
    return lifecycle.summary;
  }
  return buildMaxTurnsSummary(lifecycle, maxTurns);
}
