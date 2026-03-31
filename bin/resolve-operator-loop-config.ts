import { resolveOperatorLoopConfig } from "../src/config/operator-loop.js";

try {
  const resolved = resolveOperatorLoopConfig({
    argv: process.argv.slice(2),
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(resolved)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
