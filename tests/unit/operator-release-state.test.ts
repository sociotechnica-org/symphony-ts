import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkflowInstancePaths } from "../../src/config/workflow.js";
import {
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceKey,
} from "../../src/domain/instance-identity.js";
import {
  evaluateOperatorReleaseState,
  readOperatorReleaseState,
  syncOperatorReleaseState,
  writeOperatorReleaseState,
} from "../../src/observability/operator-release-state.js";
import { createTempDir } from "../support/git.js";

async function writeWorkflow(rootDir: string): Promise<string> {
  const workflowPath = path.join(rootDir, "WORKFLOW.md");
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
workspace:
  root: ./.tmp/workspaces
hooks:
  after_create: []
agent:
  runner:
    kind: codex
  command: codex
  prompt_transport: stdin
  timeout_ms: 1000
  env: {}
---
Prompt body
`,
    "utf8",
  );
  return workflowPath;
}

async function writeIssueSummary(args: {
  readonly instanceRoot: string;
  readonly issueNumber: number;
  readonly currentOutcome: string;
  readonly issueIdentifier?: string | undefined;
  readonly title?: string | undefined;
}): Promise<void> {
  const issueRoot = path.join(
    args.instanceRoot,
    ".var",
    "factory",
    "issues",
    args.issueNumber.toString(),
  );
  await fs.mkdir(issueRoot, { recursive: true });
  await fs.writeFile(
    path.join(issueRoot, "issue.json"),
    `${JSON.stringify(
      {
        version: 1,
        issueNumber: args.issueNumber,
        issueIdentifier:
          args.issueIdentifier ?? `sociotechnica-org/symphony-ts#${args.issueNumber.toString()}`,
        repo: "sociotechnica-org/symphony-ts",
        title: args.title ?? `Issue ${args.issueNumber.toString()}`,
        issueUrl: `https://github.com/sociotechnica-org/symphony-ts/issues/${args.issueNumber.toString()}`,
        branch: null,
        currentOutcome: args.currentOutcome,
        currentSummary: `Outcome ${args.currentOutcome}`,
        firstObservedAt: "2026-03-30T00:00:00Z",
        lastUpdatedAt: "2026-03-30T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        latestAttemptNumber: null,
        latestSessionId: null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("operator release state", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.length = 0;
  });

  it("blocks release advancement when any configured prerequisite has failed", () => {
    const evaluation = evaluateOperatorReleaseState({
      configuration: {
        releaseId: "context-library-bun-migration",
        dependencies: [
          {
            prerequisite: {
              issueNumber: 111,
              issueIdentifier: "sociotechnica-org/symphony-ts#111",
              title: "Prerequisite",
            },
            downstream: [
              {
                issueNumber: 112,
                issueIdentifier: "sociotechnica-org/symphony-ts#112",
                title: "Downstream",
              },
            ],
          },
        ],
      },
      issueSummaries: [
        {
          issueNumber: 111,
          issueIdentifier: "sociotechnica-org/symphony-ts#111",
          title: "Prerequisite",
          currentOutcome: "failed",
        },
        {
          issueNumber: 112,
          issueIdentifier: "sociotechnica-org/symphony-ts#112",
          title: "Downstream",
          currentOutcome: "awaiting-landing-command",
        },
      ],
      evaluatedAt: "2026-03-30T00:00:00Z",
    });

    expect(evaluation.advancementState).toBe(
      "blocked-by-prerequisite-failure",
    );
    expect(evaluation.blockingPrerequisite?.issueNumber).toBe(111);
    expect(evaluation.blockedDownstream.map((issue) => issue.issueNumber)).toEqual(
      [112],
    );
    expect(evaluation.summary).toContain("#111");
  });

  it("fails closed when dependency metadata references unresolved issues", () => {
    const evaluation = evaluateOperatorReleaseState({
      configuration: {
        releaseId: "context-library-bun-migration",
        dependencies: [
          {
            prerequisite: {
              issueNumber: 111,
              issueIdentifier: "sociotechnica-org/symphony-ts#111",
              title: "Prerequisite",
            },
            downstream: [
              {
                issueNumber: 112,
                issueIdentifier: "sociotechnica-org/symphony-ts#112",
                title: "Downstream",
              },
            ],
          },
        ],
      },
      issueSummaries: [
        {
          issueNumber: 111,
          issueIdentifier: "sociotechnica-org/symphony-ts#111",
          title: "Prerequisite",
          currentOutcome: "awaiting-system-checks",
        },
      ],
      evaluatedAt: "2026-03-30T00:00:00Z",
    });

    expect(evaluation.advancementState).toBe("blocked-review-needed");
    expect(evaluation.unresolvedReferences.map((issue) => issue.issueNumber)).toEqual(
      [112],
    );
  });

  it("returns configured-clear when no prerequisite has failed", () => {
    const evaluation = evaluateOperatorReleaseState({
      configuration: {
        releaseId: "context-library-bun-migration",
        dependencies: [
          {
            prerequisite: {
              issueNumber: 111,
              issueIdentifier: "sociotechnica-org/symphony-ts#111",
              title: "Prerequisite",
            },
            downstream: [
              {
                issueNumber: 112,
                issueIdentifier: "sociotechnica-org/symphony-ts#112",
                title: "Downstream",
              },
            ],
          },
        ],
      },
      issueSummaries: [
        {
          issueNumber: 111,
          issueIdentifier: "sociotechnica-org/symphony-ts#111",
          title: "Prerequisite",
          currentOutcome: "succeeded",
        },
        {
          issueNumber: 112,
          issueIdentifier: "sociotechnica-org/symphony-ts#112",
          title: "Downstream",
          currentOutcome: "awaiting-human-review",
        },
      ],
      evaluatedAt: "2026-03-30T00:00:00Z",
    });

    expect(evaluation.advancementState).toBe("configured-clear");
    expect(evaluation.summary).toContain("clear");
  });

  it("syncs a stored release-state document back to clear when the prerequisite is repaired", async () => {
    const instanceRoot = await createTempDir("symphony-release-state-instance-");
    const operatorRoot = await createTempDir("symphony-release-state-operator-");
    tempRoots.push(instanceRoot, operatorRoot);
    const workflowPath = await writeWorkflow(instanceRoot);
    const instance = await loadWorkflowInstancePaths(workflowPath);
    const instanceKey = deriveSymphonyInstanceKey(instanceRoot);
    const releaseStateFile = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: operatorRoot,
      instanceKey,
    }).releaseStatePath;

    await writeOperatorReleaseState(releaseStateFile, {
      version: 1,
      updatedAt: "2026-03-30T00:00:00Z",
      configuration: {
        releaseId: "context-library-bun-migration",
        dependencies: [
          {
            prerequisite: {
              issueNumber: 111,
              issueIdentifier: "sociotechnica-org/symphony-ts#111",
              title: "Prerequisite",
            },
            downstream: [
              {
                issueNumber: 112,
                issueIdentifier: "sociotechnica-org/symphony-ts#112",
                title: "Downstream",
              },
            ],
          },
        ],
      },
      evaluation: {
        advancementState: "blocked-by-prerequisite-failure",
        summary: "Previously blocked",
        evaluatedAt: "2026-03-30T00:00:00Z",
        blockingPrerequisite: {
          issueNumber: 111,
          issueIdentifier: "sociotechnica-org/symphony-ts#111",
          title: "Prerequisite",
        },
        blockedDownstream: [
          {
            issueNumber: 112,
            issueIdentifier: "sociotechnica-org/symphony-ts#112",
            title: "Downstream",
          },
        ],
        unresolvedReferences: [],
      },
    });

    await writeIssueSummary({
      instanceRoot,
      issueNumber: 111,
      currentOutcome: "succeeded",
    });
    await writeIssueSummary({
      instanceRoot,
      issueNumber: 112,
      currentOutcome: "awaiting-landing-command",
    });

    const synced = await syncOperatorReleaseState({
      instance,
      releaseStateFile,
      updatedAt: "2026-03-30T01:00:00Z",
    });
    const stored = await readOperatorReleaseState(releaseStateFile);

    expect(synced.evaluation.advancementState).toBe("configured-clear");
    expect(stored.evaluation.advancementState).toBe("configured-clear");
    expect(stored.updatedAt).toBe("2026-03-30T01:00:00Z");
  });
});
