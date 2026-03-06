#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { summarizeChecks } from "./fix-ci-lib.mjs";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const options = {
    pr: null,
    repo: process.env["GITHUB_REPO"] ?? null,
    intervalSeconds: 15,
    timeoutSeconds: 1800,
    once: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pr") {
      options.pr = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      options.repo = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--interval") {
      options.intervalSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      options.timeoutSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (
    options.pr !== null &&
    (!Number.isInteger(options.pr) || options.pr <= 0)
  ) {
    throw new Error(`Invalid PR number: ${options.pr}`);
  }
  if (
    !Number.isFinite(options.intervalSeconds) ||
    options.intervalSeconds <= 0
  ) {
    throw new Error(`Invalid interval: ${options.intervalSeconds}`);
  }
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error(`Invalid timeout: ${options.timeoutSeconds}`);
  }

  return options;
}

async function ghJson(args, repo) {
  const fullArgs = [...args];
  if (repo !== null) {
    fullArgs.push("--repo", repo);
  }
  const { stdout } = await execFileAsync("gh", fullArgs);
  return JSON.parse(stdout);
}

async function resolvePullRequest(options) {
  if (options.pr !== null) {
    return await ghJson(
      [
        "pr",
        "view",
        String(options.pr),
        "--json",
        "number,title,url,headRefName,baseRefName,statusCheckRollup",
      ],
      options.repo,
    );
  }

  return await ghJson(
    [
      "pr",
      "view",
      "--json",
      "number,title,url,headRefName,baseRefName,statusCheckRollup",
    ],
    options.repo,
  );
}

function printSnapshot(pullRequest, summary) {
  console.log(
    `[${new Date().toISOString()}] PR #${pullRequest.number}: ${pullRequest.title}`,
  );
  console.log(`URL: ${pullRequest.url}`);
  console.log(`Status: ${summary.overall}`);

  if (summary.checks.length === 0) {
    console.log("Checks: none reported yet");
    return;
  }

  for (const check of summary.checks) {
    const workflowPrefix = check.workflowName ? `${check.workflowName} / ` : "";
    const conclusion = check.conclusion || "-";
    console.log(
      `- ${workflowPrefix}${check.name}: status=${check.status} conclusion=${conclusion}`,
    );
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  while (true) {
    const pullRequest = await resolvePullRequest(options);
    const summary = summarizeChecks(pullRequest.statusCheckRollup);
    printSnapshot(pullRequest, summary);

    if (summary.overall === "success") {
      process.exitCode = 0;
      return;
    }

    if (summary.overall === "failure") {
      process.exitCode = 1;
      return;
    }

    if (options.once) {
      process.exitCode = 3;
      return;
    }

    if (Date.now() - startedAt >= options.timeoutSeconds * 1000) {
      console.error("Timed out waiting for CI to finish");
      process.exitCode = 2;
      return;
    }

    await sleep(options.intervalSeconds * 1000);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
