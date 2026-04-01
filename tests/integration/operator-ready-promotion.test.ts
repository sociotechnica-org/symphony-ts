import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceIdentity,
} from "../../src/domain/instance-identity.js";
import {
  createEmptyOperatorReadyPromotionResult,
  readOperatorReleaseState,
  writeOperatorReleaseState,
} from "../../src/observability/operator-release-state.js";
import { MockGitHubServer } from "../support/mock-github-server.js";
import { createTempDir } from "../support/git.js";

const execFileAsync = promisify(execFile);

async function withEnvVarUnset<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const previousValue = process.env[name];
  delete process.env[name];
  try {
    return await run();
  } finally {
    if (previousValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previousValue;
    }
  }
}

async function writeWorkflow(args: {
  readonly rootDir: string;
  readonly apiUrl: string;
}): Promise<string> {
  const workflowPath = path.join(args.rootDir, "WORKFLOW.md");
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
  api_url: ${args.apiUrl}
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: done
polling:
  interval_ms: 1000
  max_concurrent_runs: 1
  retry:
    max_attempts: 1
    backoff_ms: 1000
workspace:
  root: ./.tmp/workspaces
  repo_url: https://github.com/sociotechnica-org/symphony-ts.git
  branch_prefix: symphony/
  retention:
    on_success: delete
    on_failure: retain
hooks:
  after_create: []
agent:
  runner:
    kind: codex
  command: codex
  prompt_transport: stdin
  timeout_ms: 1000
  max_turns: 3
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
        issueIdentifier: `sociotechnica-org/symphony-ts#${args.issueNumber.toString()}`,
        repo: "sociotechnica-org/symphony-ts",
        title: `Issue ${args.issueNumber.toString()}`,
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

describe("operator ready promotion", () => {
  let server: MockGitHubServer;
  const previousToken = process.env.GH_TOKEN;
  const tempRoots: string[] = [];

  beforeEach(async () => {
    server = new MockGitHubServer();
    await server.start();
    process.env.GH_TOKEN = "test-token";
  });

  afterEach(async () => {
    if (previousToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = previousToken;
    }
    await server.stop();
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("adds ready to an eligible downstream issue and records the promotion result", async () => {
    const instanceRoot = await createTempDir("symphony-ready-promotion-");
    const operatorRoot = await createTempDir(
      "symphony-ready-promotion-operator-",
    );
    tempRoots.push(instanceRoot, operatorRoot);
    const workflowPath = await writeWorkflow({
      rootDir: instanceRoot,
      apiUrl: server.baseUrl,
    });
    const releaseStatePath = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: operatorRoot,
      instanceKey: deriveSymphonyInstanceIdentity(workflowPath).instanceKey,
    }).releaseStatePath;

    server.seedIssue({
      number: 111,
      title: "Prerequisite",
      body: "",
      labels: [],
    });
    server.seedIssue({
      number: 112,
      title: "Downstream",
      body: "",
      labels: [],
    });

    await writeOperatorReleaseState(releaseStatePath, {
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
        advancementState: "configured-clear",
        summary: "Initial value",
        evaluatedAt: "2026-03-30T00:00:00Z",
        blockingPrerequisite: null,
        blockedDownstream: [],
        unresolvedReferences: [],
      },
      promotion: createEmptyOperatorReadyPromotionResult(
        "2026-03-30T00:00:00Z",
      ),
    });
    await writeIssueSummary({
      instanceRoot,
      issueNumber: 111,
      currentOutcome: "succeeded",
    });

    await execFileAsync(
      "pnpm",
      [
        "tsx",
        "bin/promote-operator-ready-issues.ts",
        "--workflow",
        workflowPath,
        "--operator-repo-root",
        operatorRoot,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
      },
    );

    expect(server.getIssue(112).labels.map((label) => label.name)).toContain(
      "symphony:ready",
    );

    const state = await readOperatorReleaseState(releaseStatePath);
    expect(state.promotion.state).toBe("labels-synchronized");
    expect(
      state.promotion.eligibleIssues.map((issue) => issue.issueNumber),
    ).toEqual([112]);
    expect(
      state.promotion.readyLabelsAdded.map((issue) => issue.issueNumber),
    ).toEqual([112]);
  });

  it("loads the checked-in self-hosting workflow for ready promotion without SYMPHONY_REPO", async () => {
    const instanceRoot = await createTempDir("symphony-ready-promotion-root-");
    const operatorRoot = await createTempDir(
      "symphony-ready-promotion-operator-",
    );
    tempRoots.push(instanceRoot, operatorRoot);

    const workflowPath = path.join(instanceRoot, "WORKFLOW.md");
    await fs.copyFile(path.resolve(process.cwd(), "WORKFLOW.md"), workflowPath);

    const releaseStatePath = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: operatorRoot,
      instanceKey: deriveSymphonyInstanceIdentity(workflowPath).instanceKey,
    }).releaseStatePath;
    await writeOperatorReleaseState(releaseStatePath, {
      version: 1,
      updatedAt: "2026-03-30T00:00:00Z",
      configuration: {
        releaseId: null,
        dependencies: [],
      },
      evaluation: {
        advancementState: "unconfigured",
        summary: "No release dependency metadata is configured.",
        evaluatedAt: "2026-03-30T00:00:00Z",
        blockingPrerequisite: null,
        blockedDownstream: [],
        unresolvedReferences: [],
      },
      promotion: createEmptyOperatorReadyPromotionResult(
        "2026-03-30T00:00:00Z",
      ),
    });

    const { stdout } = await withEnvVarUnset("SYMPHONY_REPO", () =>
      execFileAsync(
        "pnpm",
        [
          "tsx",
          "bin/promote-operator-ready-issues.ts",
          "--workflow",
          workflowPath,
          "--operator-repo-root",
          operatorRoot,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env },
        },
      ),
    );

    expect(stdout).toContain("Ready promotion: unconfigured");
    expect(stdout).toContain(
      "No release dependency metadata is configured for this operator instance.",
    );

    const state = await readOperatorReleaseState(releaseStatePath);
    expect(state.configuration.dependencies).toEqual([]);
    expect(state.promotion.state).toBe("unconfigured");
    expect(state.promotion.error).toBeNull();
  });

  it("removes ready when a prerequisite has failed", async () => {
    const instanceRoot = await createTempDir("symphony-ready-promotion-");
    const operatorRoot = await createTempDir(
      "symphony-ready-promotion-operator-",
    );
    tempRoots.push(instanceRoot, operatorRoot);
    const workflowPath = await writeWorkflow({
      rootDir: instanceRoot,
      apiUrl: server.baseUrl,
    });
    const releaseStatePath = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: operatorRoot,
      instanceKey: deriveSymphonyInstanceIdentity(workflowPath).instanceKey,
    }).releaseStatePath;

    server.seedIssue({
      number: 111,
      title: "Prerequisite",
      body: "",
      labels: [],
    });
    server.seedIssue({
      number: 112,
      title: "Downstream",
      body: "",
      labels: ["symphony:ready"],
    });

    await writeOperatorReleaseState(releaseStatePath, {
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
        advancementState: "configured-clear",
        summary: "Initial value",
        evaluatedAt: "2026-03-30T00:00:00Z",
        blockingPrerequisite: null,
        blockedDownstream: [],
        unresolvedReferences: [],
      },
      promotion: createEmptyOperatorReadyPromotionResult(
        "2026-03-30T00:00:00Z",
      ),
    });
    await writeIssueSummary({
      instanceRoot,
      issueNumber: 111,
      currentOutcome: "failed",
    });

    await execFileAsync(
      "pnpm",
      [
        "tsx",
        "bin/promote-operator-ready-issues.ts",
        "--workflow",
        workflowPath,
        "--operator-repo-root",
        operatorRoot,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
      },
    );

    expect(
      server.getIssue(112).labels.map((label) => label.name),
    ).not.toContain("symphony:ready");

    const state = await readOperatorReleaseState(releaseStatePath);
    expect(state.evaluation.advancementState).toBe(
      "blocked-by-prerequisite-failure",
    );
    expect(state.promotion.state).toBe("labels-synchronized");
    expect(
      state.promotion.readyLabelsRemoved.map((issue) => issue.issueNumber),
    ).toEqual([112]);
  });
});
