import path from "node:path";
import {
  deriveOperatorInstanceCoordinationPaths,
  deriveOperatorInstanceStatePaths,
  deriveSymphonyInstanceIdentity,
} from "../src/domain/instance-identity.js";

interface Args {
  readonly workflowPath: string;
  readonly operatorRepoRoot: string;
}

function parseArgs(argv: readonly string[]): Args {
  const workflowPath = readOptionValue(argv, "--workflow");
  const operatorRepoRoot = readOptionValue(argv, "--operator-repo-root");
  if (workflowPath === null) {
    throw new Error("Missing value for --workflow");
  }
  if (operatorRepoRoot === null) {
    throw new Error("Missing value for --operator-repo-root");
  }
  return {
    workflowPath: path.resolve(workflowPath),
    operatorRepoRoot: path.resolve(operatorRepoRoot),
  };
}

function readOptionValue(
  argv: readonly string[],
  option: string,
): string | null {
  const index = argv.indexOf(option);
  if (index === -1) {
    return null;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

const args = parseArgs(process.argv.slice(2));
const identity = deriveSymphonyInstanceIdentity(args.workflowPath);
const operatorState = deriveOperatorInstanceStatePaths({
  operatorRepoRoot: args.operatorRepoRoot,
  instanceKey: identity.instanceKey,
});
const coordination = deriveOperatorInstanceCoordinationPaths(args.workflowPath);

process.stdout.write(
  `${JSON.stringify({
    workflowPath: args.workflowPath,
    operatorRepoRoot: args.operatorRepoRoot,
    selectedInstanceRoot: identity.instanceRoot,
    instanceKey: identity.instanceKey,
    detachedSessionName: identity.detachedSessionName,
    ...operatorState,
    ...coordination,
  })}\n`,
);
