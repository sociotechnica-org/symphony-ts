import { createHash } from "node:crypto";
import path from "node:path";
import { deriveInstanceRootFromWorkflowPath } from "./workflow.js";

const DETACHED_SESSION_PREFIX = "symphony-factory";
const OPERATOR_INSTANCES_DIRECTORY = path.join(".ralph", "instances");
const MAX_INSTANCE_LABEL_LENGTH = 24;
const INSTANCE_HASH_LENGTH = 10;

export interface SymphonyInstanceIdentity {
  readonly instanceKey: string;
  readonly detachedSessionName: string;
}

export interface OperatorInstanceStatePaths {
  readonly operatorStateRoot: string;
  readonly logDir: string;
  readonly lockDir: string;
  readonly lockInfoFile: string;
  readonly statusJsonPath: string;
  readonly statusMdPath: string;
  readonly standingContextPath: string;
  readonly wakeUpLogPath: string;
  readonly legacyScratchpadPath: string;
  readonly releaseStatePath: string;
  readonly reportReviewStatePath: string;
}

export function deriveSymphonyInstanceIdentity(
  instanceRootOrWorkflowPath: string,
): SymphonyInstanceIdentity {
  const instanceRoot = normalizeInstanceRoot(instanceRootOrWorkflowPath);
  const instanceKey = deriveSymphonyInstanceKey(instanceRoot);
  return {
    instanceKey,
    detachedSessionName: `${DETACHED_SESSION_PREFIX}-${instanceKey}`,
  };
}

export function deriveSymphonyInstanceKey(
  instanceRootOrWorkflowPath: string,
): string {
  const instanceRoot = normalizeInstanceRoot(instanceRootOrWorkflowPath);
  const instanceLabel = sanitizeInstanceLabel(path.basename(instanceRoot));
  const instanceHash = createHash("sha256")
    .update(instanceRoot)
    .digest("hex")
    .slice(0, INSTANCE_HASH_LENGTH);
  return `${instanceLabel}-${instanceHash}`;
}

export function deriveOperatorInstanceStatePaths(args: {
  readonly operatorRepoRoot: string;
  readonly instanceKey: string;
}): OperatorInstanceStatePaths {
  const operatorStateRoot = path.join(
    path.resolve(args.operatorRepoRoot),
    OPERATOR_INSTANCES_DIRECTORY,
    args.instanceKey,
  );
  const lockDir = path.join(operatorStateRoot, "operator-loop.lock");
  return {
    operatorStateRoot,
    logDir: path.join(operatorStateRoot, "logs"),
    lockDir,
    lockInfoFile: path.join(lockDir, "owner"),
    statusJsonPath: path.join(operatorStateRoot, "status.json"),
    statusMdPath: path.join(operatorStateRoot, "status.md"),
    standingContextPath: path.join(operatorStateRoot, "standing-context.md"),
    wakeUpLogPath: path.join(operatorStateRoot, "wake-up-log.md"),
    legacyScratchpadPath: path.join(
      operatorStateRoot,
      "operator-scratchpad.md",
    ),
    releaseStatePath: path.join(operatorStateRoot, "release-state.json"),
    reportReviewStatePath: path.join(
      operatorStateRoot,
      "report-review-state.json",
    ),
  };
}

function normalizeInstanceRoot(instanceRootOrWorkflowPath: string): string {
  const resolvedPath = path.resolve(instanceRootOrWorkflowPath);
  return path.basename(resolvedPath) === "WORKFLOW.md"
    ? deriveInstanceRootFromWorkflowPath(resolvedPath)
    : resolvedPath;
}

function sanitizeInstanceLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_INSTANCE_LABEL_LENGTH)
    .replace(/-+$/g, "");
  return normalized.length > 0 ? normalized : "instance";
}
