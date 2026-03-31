import type { OperatorProvider } from "../src/config/operator-loop.js";
import { recordOperatorCycle } from "../src/runner/operator-session.js";

interface Args {
  readonly provider: OperatorProvider;
  readonly model: string | null;
  readonly baseCommand: string;
  readonly resumeSession: boolean;
  readonly sessionMode: "disabled" | "fresh" | "resuming";
  readonly sessionStatePath: string;
  readonly repoRoot: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number;
  readonly logFile: string;
  readonly resetReason: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const provider = readRequiredOption(argv, "--provider");
  if (provider !== "codex" && provider !== "claude" && provider !== "custom") {
    throw new Error("Missing or invalid --provider");
  }
  const sessionMode = readRequiredOption(argv, "--session-mode");
  if (
    sessionMode !== "disabled" &&
    sessionMode !== "fresh" &&
    sessionMode !== "resuming"
  ) {
    throw new Error("Missing or invalid --session-mode");
  }
  return {
    provider,
    model: readOptionValue(argv, "--model"),
    baseCommand: readRequiredOption(argv, "--base-command"),
    resumeSession: readRequiredOption(argv, "--resume-session") === "true",
    sessionMode,
    sessionStatePath: readRequiredOption(argv, "--session-state-path"),
    repoRoot: readRequiredOption(argv, "--repo-root"),
    startedAt: readRequiredOption(argv, "--started-at"),
    finishedAt: readRequiredOption(argv, "--finished-at"),
    exitCode: Number.parseInt(readRequiredOption(argv, "--exit-code"), 10),
    logFile: readRequiredOption(argv, "--log-file"),
    resetReason: normalizeNullableOption(
      readOptionValue(argv, "--reset-reason"),
    ),
  };
}

function readRequiredOption(argv: readonly string[], option: string): string {
  const value = readOptionValue(argv, option);
  if (value === null) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
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

function normalizeNullableOption(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const recorded = await recordOperatorCycle(args);
  process.stdout.write(`${JSON.stringify(recorded)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
