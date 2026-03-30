import path from "node:path";
import type { RunSession } from "../domain/run.js";
import { getPreparedWorkspacePath } from "../domain/workspace.js";
import { deriveWatchdogLogPath } from "../domain/watchdog-log.js";
import type { RunnerLogPointer } from "./service.js";

export function createLocalProcessWatchdogLogPointers(
  session: RunSession,
): readonly RunnerLogPointer[] {
  const workspacePath = getPreparedWorkspacePath(session.workspace);
  if (workspacePath === null) {
    return [];
  }

  return [
    {
      name: "watchdog-activity",
      location: deriveWatchdogLogPath({
        workspaceRoot: path.dirname(workspacePath),
        issueNumber: session.issue.number,
        runSessionId: session.id,
      }),
      archiveLocation: null,
    },
  ];
}
