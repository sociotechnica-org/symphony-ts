import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceIdentity,
  deriveSymphonyInstanceKey,
} from "../../src/domain/instance-identity.js";

describe("instance identity helpers", () => {
  it("derives stable distinct instance keys from different instance roots", () => {
    const first = deriveSymphonyInstanceKey("/tmp/project-a");
    const second = deriveSymphonyInstanceKey("/tmp/project-b");

    expect(first).not.toBe(second);
    expect(first).toMatch(/^project-a-[0-9a-f]{10}$/);
    expect(second).toMatch(/^project-b-[0-9a-f]{10}$/);
  });

  it("derives detached session identity from a workflow path", () => {
    const identity = deriveSymphonyInstanceIdentity(
      "/tmp/project-a/WORKFLOW.md",
    );

    expect(identity.instanceKey).toMatch(/^project-a-[0-9a-f]{10}$/);
    expect(identity.detachedSessionName).toBe(
      `symphony-factory-${identity.instanceKey}`,
    );
  });

  it("derives per-instance operator state roots under .ralph/instances", () => {
    const instanceKey = deriveSymphonyInstanceKey("/tmp/project-a");
    const paths = deriveOperatorInstanceStatePaths({
      operatorRepoRoot: "/tmp/operator-checkout",
      instanceKey,
    });

    expect(paths.operatorStateRoot).toBe(
      path.join("/tmp/operator-checkout", ".ralph", "instances", instanceKey),
    );
    expect(paths.statusJsonPath).toBe(
      path.join(paths.operatorStateRoot, "status.json"),
    );
    expect(paths.scratchpadPath).toBe(
      path.join(paths.operatorStateRoot, "operator-scratchpad.md"),
    );
  });
});
