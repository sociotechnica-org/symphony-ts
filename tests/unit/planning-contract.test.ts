import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function readRepoFileLowercased(relativePath: string): Promise<string> {
  return (
    await fs.readFile(path.join(repoRoot, relativePath), "utf8")
  ).toLowerCase();
}

function expectPhrases(content: string, phrases: readonly string[]): void {
  for (const phrase of phrases) {
    expect.soft(content).toContain(phrase);
  }
}

describe("repo planning contract", () => {
  it("keeps the symphony plan skill explicit about spec layers and seams", async () => {
    const content = await readRepoFileLowercased(
      "skills/symphony-plan/SKILL.md",
    );

    expectPhrases(content, [
      "1. goal",
      "2. scope",
      "non-goals",
      "current gaps",
      "architecture boundaries",
      "policy layer",
      "configuration layer",
      "coordination layer",
      "execution layer",
      "integration layer",
      "observability layer",
      "observability requirements",
      "slice strategy",
      "one issue / one pr",
      "transport, normalization, and policy",
      "runtime state machine",
      "implementation steps",
      "failure-class matrix",
      "acceptance scenarios",
      "exit criteria",
      "decision notes",
      "docs/architecture.md",
      "deferred",
      "human review station",
      "plan-ready",
      "in review",
      "revise",
      "approved",
      "waived",
      "human feedback",
      "wait for human review", // SKILL.md §Plan Output step 4 — keep this exact wording
    ]);
  });

  it("keeps a local abstraction-level fallback in architecture docs", async () => {
    const content = await readRepoFileLowercased("docs/architecture.md");

    expectPhrases(content, [
      "spec abstraction levels",
      "policy layer",
      "configuration layer",
      "coordination layer",
      "execution layer",
      "integration layer",
      "observability layer",
      "workflow.md",
      "src/config/",
      "src/orchestrator/",
      "src/workspace/",
      "src/runner/",
      "src/tracker/",
      "src/observability/",
    ]);
  });

  it("keeps workflow instructions plan-first and decomposition-aware", async () => {
    const content = await readRepoFileLowercased("WORKFLOW.md");

    expectPhrases(content, [
      "spec.md",
      "policy, configuration, coordination, execution, integration, and observability",
      "name scope, non-goals",
      "current gaps",
      "architecture boundaries",
      "implementation steps, tests",
      "slice strategy",
      "acceptance scenarios",
      "exit criteria",
      "runtime state machine",
      "failure-class matrix",
      "leases",
      "transport, normalization, and policy",
      "docs/architecture.md",
      "one issue / one pr",
      "deferred",
      "draft -> plan-ready -> in review",
      "loop",
      "revise -> plan-ready",
      "as needed",
      "human handoff",
      "do not begin substantial implementation",
      "approved",
      "waived",
      "human feedback",
    ]);
  });

  it("keeps repo policy explicit about narrow pr seams", async () => {
    const content = await readRepoFileLowercased("AGENTS.md");

    expectPhrases(content, [
      "planning standard",
      "policy, configuration, coordination, execution, integration, and observability",
      "name scope, non-goals",
      "current gaps",
      "architecture boundaries",
      "implementation steps, tests",
      "acceptance scenarios",
      "exit criteria",
      "slice strategy",
      "runtime state machine",
      "failure-class matrix",
      "leases",
      "transport, normalization, and policy",
      "docs/architecture.md",
      "one issue / one pr",
      "phase 1.2",
      "deferred",
      "plan-ready",
      "in review",
      "revise -> plan-ready",
      "approved",
      "waives waiting", // AGENTS.md §Issue Workflow step 5 — keep this exact wording
      "human review station",
    ]);
  });

  it("keeps readme explicit about the human plan review station for operators", async () => {
    const content = await readRepoFileLowercased("README.md");

    expectPhrases(content, [
      "technical plan review station",
      "plan-ready",
      "human feedback",
      "approved or explicitly waived",
      "issue comments",
      "human review station",
      "plan approval is waived",
    ]);
  });
});
