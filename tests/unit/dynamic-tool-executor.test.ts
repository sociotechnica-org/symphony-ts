import { describe, expect, it } from "vitest";
import type { RunSession } from "../../src/domain/run.js";
import { createConfiguredWorkspaceSource } from "../../src/domain/workspace.js";
import {
  RunnerDynamicToolExecutor,
  TRACKER_CURRENT_CONTEXT_TOOL_NAME,
} from "../../src/runner/dynamic-tool-executor.js";
import type { TrackerToolService } from "../../src/tracker/tool-service.js";

function createRunSession(): RunSession {
  return {
    id: "session-186",
    issue: {
      id: "186",
      identifier: "sociotechnica-org/symphony-ts#186",
      number: 186,
      title: "Dynamic tools",
      description: "",
      labels: ["symphony:running"],
      state: "open",
      url: "https://example.test/issues/186",
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      queuePriority: null,
    },
    workspace: {
      key: "sociotechnica-org_symphony-ts_186",
      branchName: "symphony/186",
      createdNow: false,
      source: createConfiguredWorkspaceSource(process.cwd()),
      target: {
        kind: "local",
        path: process.cwd(),
      },
    },
    prompt: "prompt",
    startedAt: "2026-03-19T00:00:00.000Z",
    attempt: {
      sequence: 1,
    },
  };
}

function createTrackerToolService(): TrackerToolService {
  return {
    async readCurrentContext(runSession) {
      return {
        branchName: runSession.workspace.branchName,
        issue: {
          identifier: runSession.issue.identifier,
          number: runSession.issue.number,
          title: runSession.issue.title,
          labels: runSession.issue.labels,
          state: runSession.issue.state,
          url: runSession.issue.url,
          summary: "Sanitized tracker summary",
        },
        pullRequest: null,
        retrievedAt: "2026-03-19T00:00:00.000Z",
      };
    },
  };
}

describe("runner dynamic tool executor", () => {
  it("accepts omitted arguments for tracker_current_context", async () => {
    const executor = new RunnerDynamicToolExecutor(createTrackerToolService());
    const runSession = createRunSession();

    await expect(
      executor.execute(
        {
          tool: TRACKER_CURRENT_CONTEXT_TOOL_NAME,
          arguments: undefined,
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
        },
        {
          runSession,
        },
      ),
    ).resolves.toMatchObject({
      kind: "completed",
      result: {
        success: true,
      },
    });
  });

  it("accepts null arguments for tracker_current_context", async () => {
    const executor = new RunnerDynamicToolExecutor(createTrackerToolService());
    const runSession = createRunSession();

    await expect(
      executor.execute(
        {
          tool: TRACKER_CURRENT_CONTEXT_TOOL_NAME,
          arguments: null,
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
        },
        {
          runSession,
        },
      ),
    ).resolves.toMatchObject({
      kind: "completed",
      result: {
        success: true,
      },
    });
  });
});
