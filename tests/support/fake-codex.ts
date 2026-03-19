import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "./git.js";

export async function createFakeCodexExecutable(): Promise<string> {
  const dir = await createTempDir("fake-codex-");
  const executablePath = path.join(dir, "codex");
  await fs.writeFile(
    executablePath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const logFile = process.env.FAKE_CODEX_LOG_FILE ?? null;
const agentCommand = process.env.FAKE_CODEX_AGENT_COMMAND ?? null;
let turnCount = 0;
const threadId = "thread-1";

function log(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n");
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

if (process.argv[2] !== "app-server") {
  process.stderr.write("unexpected command: " + process.argv.slice(2).join(" "));
  process.exit(1);
}

process.on("SIGTERM", () => {
  process.exit(0);
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch (error) {
    process.stderr.write(String(error));
    process.exit(1);
  }
  log(payload);

  if (payload.method === "initialize") {
    send({ id: payload.id, result: { userAgent: "fake-codex" } });
    return;
  }

  if (payload.method === "initialized") {
    return;
  }

  if (payload.method === "thread/start") {
    send({
      id: payload.id,
      result: {
        approvalPolicy: "never",
        cwd: process.cwd(),
        model: "gpt-5.4",
        modelProvider: "openai",
        sandbox: { type: "dangerFullAccess" },
        thread: { id: threadId },
      },
    });
    return;
  }

  if (payload.method === "turn/start") {
    turnCount += 1;
    const turnId = "turn-" + String(turnCount);
    send({ id: payload.id, result: { turn: { id: turnId } } });
    send({
      method: "turn/started",
      params: {
        threadId,
        turn: { id: turnId },
      },
    });

    const complete = (code, stderr) => {
      if (code === 0) {
        send({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId },
          },
        });
        return;
      }
      send({
        method: "turn/failed",
        params: {
          threadId,
          turn: { id: turnId },
          message: stderr || "fake codex agent command failed",
        },
      });
    };

    if (!agentCommand) {
      complete(0, "");
      return;
    }

    const child = spawn("bash", ["-lc", agentCommand], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(
      JSON.stringify(payload.params?.input ?? []) + "\\n",
      "utf8",
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      complete(code ?? 1, stderr.trim());
    });
    return;
  }
});
`,
    "utf8",
  );
  await fs.chmod(executablePath, 0o755);
  return executablePath;
}
