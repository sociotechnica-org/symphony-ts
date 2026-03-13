export interface LandingRuntimeState {
  readonly attemptedHeadShaByIssueNumber: Map<number, string | null>;
}

export function createLandingRuntimeState(): LandingRuntimeState {
  return {
    attemptedHeadShaByIssueNumber: new Map<number, string | null>(),
  };
}

export function clearLandingRuntimeState(
  state: LandingRuntimeState,
  issueNumber: number,
): void {
  state.attemptedHeadShaByIssueNumber.delete(issueNumber);
}

export function shouldExecuteLanding(
  state: LandingRuntimeState,
  issueNumber: number,
  headSha: string | null,
): boolean {
  if (!state.attemptedHeadShaByIssueNumber.has(issueNumber)) {
    return true;
  }
  return state.attemptedHeadShaByIssueNumber.get(issueNumber) !== headSha;
}

export function noteLandingAttempt(
  state: LandingRuntimeState,
  issueNumber: number,
  headSha: string | null,
): void {
  state.attemptedHeadShaByIssueNumber.set(issueNumber, headSha);
}
