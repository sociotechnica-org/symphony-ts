export type OperatorRuntimeState =
  | "bootstrapping"
  | "acquiring-loop-lock"
  | "sleeping"
  | "preparing-cycle"
  | "acquiring-active-lease"
  | "running-command"
  | "post-cycle-refresh"
  | "recording-success"
  | "recording-failure"
  | "retrying"
  | "stopping"
  | "stopped";

const allowedTransitions: Readonly<
  Record<OperatorRuntimeState, readonly OperatorRuntimeState[]>
> = {
  bootstrapping: ["acquiring-loop-lock"],
  "acquiring-loop-lock": ["sleeping", "preparing-cycle", "stopping"],
  sleeping: ["preparing-cycle", "stopping"],
  "preparing-cycle": [
    "acquiring-active-lease",
    "recording-failure",
    "stopping",
  ],
  "acquiring-active-lease": [
    "running-command",
    "recording-failure",
    "stopping",
  ],
  "running-command": ["post-cycle-refresh", "stopping"],
  "post-cycle-refresh": ["recording-success", "recording-failure", "stopping"],
  "recording-success": ["recording-failure", "sleeping", "stopped", "stopping"],
  "recording-failure": ["retrying", "stopped", "stopping"],
  retrying: ["preparing-cycle", "stopping"],
  stopping: ["stopped"],
  stopped: [],
};

export function canTransitionOperatorRuntimeState(args: {
  readonly from: OperatorRuntimeState;
  readonly to: OperatorRuntimeState;
}): boolean {
  return allowedTransitions[args.from].includes(args.to);
}

export function assertOperatorRuntimeTransition(args: {
  readonly from: OperatorRuntimeState;
  readonly to: OperatorRuntimeState;
}): void {
  if (canTransitionOperatorRuntimeState(args)) {
    return;
  }

  throw new Error(
    `operator-loop: invalid runtime state transition ${args.from} -> ${args.to}`,
  );
}
