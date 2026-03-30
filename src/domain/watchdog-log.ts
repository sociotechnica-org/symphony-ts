import path from "node:path";

export function deriveWatchdogLogFileName(options: {
  readonly issueNumber: number;
  readonly runSessionId: string | null;
}): string {
  return options.runSessionId === null
    ? `${options.issueNumber.toString()}.log`
    : `${encodeURIComponent(options.runSessionId)}.log`;
}

export function deriveWatchdogLogPath(options: {
  readonly workspaceRoot: string;
  readonly issueNumber: number;
  readonly runSessionId: string | null;
}): string {
  return path.join(
    options.workspaceRoot,
    ".symphony",
    deriveWatchdogLogFileName(options),
  );
}
