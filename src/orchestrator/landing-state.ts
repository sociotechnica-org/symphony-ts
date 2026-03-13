export interface LandingRuntimeState {
  readonly attemptedHeadShaByIssueNumber: Map<number, string>;
}

export function createLandingRuntimeState(): LandingRuntimeState {
  return {
    attemptedHeadShaByIssueNumber: new Map<number, string>(),
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
  if (headSha === null) {
    return true;
  }
  return state.attemptedHeadShaByIssueNumber.get(issueNumber) !== headSha;
}

export function noteLandingAttempt(
  state: LandingRuntimeState,
  issueNumber: number,
  headSha: string | null,
): void {
  if (headSha === null) {
    state.attemptedHeadShaByIssueNumber.delete(issueNumber);
    return;
  }
  state.attemptedHeadShaByIssueNumber.set(issueNumber, headSha);
}
