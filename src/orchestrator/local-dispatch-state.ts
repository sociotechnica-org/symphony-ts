export interface LocalDispatchRuntimeState {
  readonly reservedIssueNumbers: Set<number>;
  readonly backgroundTasks: Map<number, Promise<void>>;
}

export function createLocalDispatchRuntimeState(): LocalDispatchRuntimeState {
  return {
    reservedIssueNumbers: new Set<number>(),
    backgroundTasks: new Map<number, Promise<void>>(),
  };
}

export function countReservedLocalDispatches(
  state: LocalDispatchRuntimeState,
): number {
  return state.reservedIssueNumbers.size;
}

export function hasReservedLocalDispatch(
  state: LocalDispatchRuntimeState,
  issueNumber: number,
): boolean {
  return state.reservedIssueNumbers.has(issueNumber);
}

export function reserveLocalDispatch(
  state: LocalDispatchRuntimeState,
  issueNumber: number,
): boolean {
  if (state.reservedIssueNumbers.has(issueNumber)) {
    return false;
  }
  state.reservedIssueNumbers.add(issueNumber);
  return true;
}

export function noteBackgroundDispatchTask(
  state: LocalDispatchRuntimeState,
  issueNumber: number,
  task: Promise<void>,
): void {
  state.backgroundTasks.set(issueNumber, task);
}

export function releaseLocalDispatch(
  state: LocalDispatchRuntimeState,
  issueNumber: number,
): void {
  state.reservedIssueNumbers.delete(issueNumber);
  state.backgroundTasks.delete(issueNumber);
}

export function listReservedLocalDispatches(
  state: LocalDispatchRuntimeState,
): readonly number[] {
  return [...state.reservedIssueNumbers];
}

export function listBackgroundDispatchTasks(
  state: LocalDispatchRuntimeState,
): readonly Promise<void>[] {
  return [...state.backgroundTasks.values()];
}
