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

    expect(identity.instanceRoot).toBe("/tmp/project-a");
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
    expect(paths.standingContextPath).toBe(
      path.join(paths.operatorStateRoot, "standing-context.md"),
    );
    expect(paths.wakeUpLogPath).toBe(
      path.join(paths.operatorStateRoot, "wake-up-log.md"),
    );
    expect(paths.legacyScratchpadPath).toBe(
      path.join(paths.operatorStateRoot, "operator-scratchpad.md"),
    );
    expect(paths.releaseStatePath).toBe(
      path.join(paths.operatorStateRoot, "release-state.json"),
    );
    expect(paths.reportReviewStatePath).toBe(
      path.join(paths.operatorStateRoot, "report-review-state.json"),
    );
    expect(paths.sessionStatePath).toBe(
      path.join(paths.operatorStateRoot, "operator-session.json"),
    );
  });
});
