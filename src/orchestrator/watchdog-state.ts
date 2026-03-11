import type { LivenessSnapshot, WatchdogEntry } from "./stall-detector.js";
import { createWatchdogEntry } from "./stall-detector.js";

export interface WatchdogRuntimeState {
  readonly activeEntries: Map<number, WatchdogEntry>;
  readonly recoveryCounts: Map<number, number>;
}

export function createWatchdogRuntimeState(): WatchdogRuntimeState {
  return {
    activeEntries: new Map<number, WatchdogEntry>(),
    recoveryCounts: new Map<number, number>(),
  };
}

export function initWatchdogEntry(
  state: WatchdogRuntimeState,
  issueNumber: number,
  snapshot: LivenessSnapshot,
): WatchdogEntry {
  const existing = state.activeEntries.get(issueNumber);
  if (existing !== undefined) {
    return existing;
  }
  const entry = createWatchdogEntry(
    issueNumber,
    snapshot,
    state.recoveryCounts.get(issueNumber) ?? 0,
  );
  state.activeEntries.set(issueNumber, entry);
  return entry;
}

export function clearActiveWatchdogEntry(
  state: WatchdogRuntimeState,
  issueNumber: number,
): void {
  state.activeEntries.delete(issueNumber);
}

export function clearWatchdogIssueState(
  state: WatchdogRuntimeState,
  issueNumber: number,
): void {
  state.activeEntries.delete(issueNumber);
  state.recoveryCounts.delete(issueNumber);
}

export function recordWatchdogRecovery(
  state: WatchdogRuntimeState,
  entry: WatchdogEntry,
): number {
  entry.recoveryCount += 1;
  state.recoveryCounts.set(entry.issueNumber, entry.recoveryCount);
  return entry.recoveryCount;
}
