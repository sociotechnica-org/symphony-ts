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
      "goal",
      "scope",
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
      "implementation steps",
      "tests",
      "one issue / one pr",
      "transport, normalization, and policy",
      "runtime state machine",
      "failure-class matrix",
      "acceptance scenarios",
      "exit criteria",
      "decision notes",
      "docs/architecture.md",
      "deferred",
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
      "non-goals",
      "current gaps",
      "architecture boundaries",
      "slice strategy",
      "acceptance scenarios",
      "runtime state machine",
      "failure-class matrix",
      "leases",
      "transport, normalization, and policy",
      "docs/architecture.md",
      "one issue / one pr",
      "deferred",
    ]);
  });

  it("keeps repo policy explicit about narrow pr seams", async () => {
    const content = await readRepoFileLowercased("AGENTS.md");

    expectPhrases(content, [
      "planning standard",
      "policy, configuration, coordination, execution, integration, and observability",
      "scope",
      "non-goals",
      "current gaps",
      "architecture boundaries",
      "implementation steps",
      "tests",
      "acceptance scenarios",
      "exit criteria",
      "slice strategy",
      "runtime state machine",
      "failure-class matrix",
      "transport, normalization, and policy",
      "docs/architecture.md",
      "one issue / one pr",
      "phase 1.2",
      "deferred",
    ]);
  });
});
