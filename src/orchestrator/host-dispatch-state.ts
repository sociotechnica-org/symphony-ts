import type { SshWorkerHostConfig } from "../domain/workflow.js";

export interface HostReservation {
  readonly issueNumber: number;
  readonly runSessionId: string | null;
}

export interface HostDispatchHostSnapshot {
  readonly name: string;
  readonly occupiedByIssueNumber: number | null;
  readonly preferredIssueNumbers: readonly number[];
}

export interface HostDispatchRuntimeState {
  readonly workerHostsByName: Readonly<Record<string, SshWorkerHostConfig>>;
  readonly hostOrder: readonly string[];
  readonly occupancyByHost: Map<string, HostReservation>;
  readonly preferredHostByIssueNumber: Map<number, string>;
}

export type HostReservationResult =
  | {
      readonly kind: "selected";
      readonly workerHost: SshWorkerHostConfig;
      readonly preferred: boolean;
    }
  | {
      readonly kind: "blocked";
      readonly preferredHost: string | null;
      readonly occupiedHosts: readonly string[];
    };

export function createHostDispatchState(
  workerHosts: readonly SshWorkerHostConfig[],
): HostDispatchRuntimeState {
  return {
    workerHostsByName: Object.fromEntries(
      workerHosts.map((workerHost) => [workerHost.name, workerHost] as const),
    ),
    hostOrder: workerHosts.map((workerHost) => workerHost.name),
    occupancyByHost: new Map(),
    preferredHostByIssueNumber: new Map(),
  };
}

export function hasHostDispatchCapacity(
  state: HostDispatchRuntimeState,
): boolean {
  return state.hostOrder.length > 0;
}

export function reserveHostForIssue(
  state: HostDispatchRuntimeState,
  issueNumber: number,
): HostReservationResult {
  const preferredHostName =
    state.preferredHostByIssueNumber.get(issueNumber) ?? null;
  if (
    preferredHostName !== null &&
    !state.occupancyByHost.has(preferredHostName)
  ) {
    const preferredWorkerHost = state.workerHostsByName[preferredHostName];
    if (preferredWorkerHost !== undefined) {
      state.occupancyByHost.set(preferredHostName, {
        issueNumber,
        runSessionId: null,
      });
      return {
        kind: "selected",
        workerHost: preferredWorkerHost,
        preferred: true,
      };
    }
  }

  for (const hostName of state.hostOrder) {
    if (state.occupancyByHost.has(hostName)) {
      continue;
    }
    const workerHost = state.workerHostsByName[hostName];
    if (workerHost === undefined) {
      continue;
    }
    state.occupancyByHost.set(hostName, {
      issueNumber,
      runSessionId: null,
    });
    return {
      kind: "selected",
      workerHost,
      preferred: false,
    };
  }

  return {
    kind: "blocked",
    preferredHost: preferredHostName,
    occupiedHosts: state.hostOrder.filter((hostName) =>
      state.occupancyByHost.has(hostName),
    ),
  };
}

export function bindHostReservationToRunSession(
  state: HostDispatchRuntimeState,
  hostName: string,
  issueNumber: number,
  runSessionId: string,
): void {
  const reservation = state.occupancyByHost.get(hostName);
  if (reservation?.issueNumber !== issueNumber) {
    return;
  }
  state.occupancyByHost.set(hostName, {
    issueNumber,
    runSessionId,
  });
}

export function notePreferredHost(
  state: HostDispatchRuntimeState,
  issueNumber: number,
  hostName: string,
): void {
  if (state.workerHostsByName[hostName] === undefined) {
    return;
  }
  state.preferredHostByIssueNumber.set(issueNumber, hostName);
}

export function clearPreferredHost(
  state: HostDispatchRuntimeState,
  issueNumber: number,
): void {
  state.preferredHostByIssueNumber.delete(issueNumber);
}

export function releaseHostForIssue(
  state: HostDispatchRuntimeState,
  issueNumber: number,
): void {
  for (const [hostName, reservation] of state.occupancyByHost.entries()) {
    if (reservation.issueNumber === issueNumber) {
      state.occupancyByHost.delete(hostName);
    }
  }
}

export function readPreferredHost(
  state: HostDispatchRuntimeState,
  issueNumber: number,
): string | null {
  return state.preferredHostByIssueNumber.get(issueNumber) ?? null;
}

export function listHostDispatchSnapshots(
  state: HostDispatchRuntimeState,
): readonly HostDispatchHostSnapshot[] {
  return state.hostOrder.map((hostName) => ({
    name: hostName,
    occupiedByIssueNumber:
      state.occupancyByHost.get(hostName)?.issueNumber ?? null,
    preferredIssueNumbers: [...state.preferredHostByIssueNumber.entries()]
      .filter(([, preferredHostName]) => preferredHostName === hostName)
      .map(([issueNumber]) => issueNumber)
      .sort((left, right) => left - right),
  }));
}
