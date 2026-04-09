#!/usr/bin/env node
import fs from "node:fs/promises";
import {
  assertOperatorRuntimeBootstrap,
  parseOperatorLoopCliArgs,
  renderOperatorLoopUsage,
  resolveOperatorRuntimeContext,
} from "../src/operator/context.js";
import {
  runOperatorLoop,
  type OperatorRuntimeHooks,
} from "../src/operator/runtime.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${renderOperatorLoopUsage()}\n`);
    return;
  }

  const cli = parseOperatorLoopCliArgs(argv);
  const context = resolveOperatorRuntimeContext({
    repoRoot: cli.repoRoot,
    promptFile: cli.promptFile,
    argv: cli.publicArgv,
    env: process.env,
  });
  await assertOperatorRuntimeBootstrap(context);
  const exitCode = await runOperatorLoop(
    context,
    createOperatorRuntimeHooksFromEnv(process.env),
  );
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

function createOperatorRuntimeHooksFromEnv(
  env: NodeJS.ProcessEnv,
): OperatorRuntimeHooks {
  if (env.SYMPHONY_TEST_FORCE_ACTIVE_WAKE_UP_LEASE_FAILURE !== "1") {
    return {};
  }

  return {
    beforeAcquireActiveWakeUpLease: async (context) => {
      if (
        env.SYMPHONY_TEST_ACTIVE_WAKE_UP_LOCK_DIR !==
        context.activeWakeUpLockDir
      ) {
        return;
      }

      await fs.mkdir(context.activeWakeUpLockDir, { recursive: true });
      await fs.writeFile(
        context.activeWakeUpOwnerFile,
        [
          `pid=${env.SYMPHONY_TEST_ACTIVE_WAKE_UP_LEASE_FAIL_PID ?? ""}`,
          "operator_repo_root=" +
            (env.SYMPHONY_TEST_ACTIVE_WAKE_UP_LEASE_OWNER_REPO_ROOT ??
              "/tmp/owner-repo"),
          "selected_instance_root=" +
            (env.SYMPHONY_TEST_ACTIVE_WAKE_UP_LEASE_OWNER_INSTANCE_ROOT ??
              "/tmp/owner-instance"),
          `workflow_path=${
            env.SYMPHONY_TEST_ACTIVE_WAKE_UP_LEASE_OWNER_WORKFLOW ??
            "/tmp/owner-instance/WORKFLOW.md"
          }`,
        ].join("\n") + "\n",
        "utf8",
      );
    },
  };
}
