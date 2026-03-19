import type { RunSession } from "../domain/run.js";

export function createRunnerEnvironment(
  session: RunSession,
  turnNumber: number,
  workspacePath: string,
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return {
    ...env,
    SYMPHONY_ISSUE_ID: session.issue.id,
    SYMPHONY_ISSUE_IDENTIFIER: session.issue.identifier,
    SYMPHONY_ISSUE_NUMBER: String(session.issue.number),
    SYMPHONY_RUN_ATTEMPT: String(session.attempt.sequence),
    SYMPHONY_RUN_TURN: String(turnNumber),
    SYMPHONY_BRANCH_NAME: session.workspace.branchName,
    SYMPHONY_WORKSPACE_PATH: workspacePath,
    SYMPHONY_RUN_SESSION_ID: session.id,
  };
}
