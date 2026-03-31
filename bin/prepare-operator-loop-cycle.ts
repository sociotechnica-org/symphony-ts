import { type OperatorProvider } from "../src/config/operator-loop.js";
import { prepareOperatorCycle } from "../src/runner/operator-session.js";

interface Args {
  readonly provider: OperatorProvider;
  readonly model: string | null;
  readonly baseCommand: string;
  readonly resumeSession: boolean;
  readonly sessionStatePath: string;
}

function parseArgs(argv: readonly string[]): Args {
  const provider = readOptionValue(argv, "--provider");
  const baseCommand = readOptionValue(argv, "--base-command");
  const sessionStatePath = readOptionValue(argv, "--session-state-path");
  if (provider !== "codex" && provider !== "claude" && provider !== "custom") {
    throw new Error("Missing or invalid --provider");
  }
  if (baseCommand === null) {
    throw new Error("Missing value for --base-command");
  }
  if (sessionStatePath === null) {
    throw new Error("Missing value for --session-state-path");
  }
  const model = readOptionValue(argv, "--model");
  const resumeRaw = readOptionValue(argv, "--resume-session");
  return {
    provider,
    model,
    baseCommand,
    resumeSession: resumeRaw === "true",
    sessionStatePath,
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prepared = await prepareOperatorCycle(args);
  process.stdout.write(`${JSON.stringify(prepared)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
