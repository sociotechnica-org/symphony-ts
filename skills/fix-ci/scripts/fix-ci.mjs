#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nextPollDelayMilliseconds, summarizeChecks } from "./fix-ci-lib.mjs";

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

async function resolveRepoName(repo) {
  if (repo !== null) {
    return repo;
  }

  const { stdout } = await execFileAsync("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);

  const inferredRepo = stdout.trim();
  if (!inferredRepo.includes("/")) {
    throw new Error("Unable to infer repo in owner/name form");
  }

  return inferredRepo;
}

function parseRepo(repo) {
  const [owner, name] = repo.split("/", 2);
  return { owner, name };
}

async function fetchReviewThreads(pullRequestNumber, repo) {
  const { owner, name } = parseRepo(repo);
  const result = await ghJson(
    [
      "api",
      "graphql",
      "-f",
      "query=query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { reviewThreads(first: 100) { nodes { id isResolved isOutdated comments(first: 20) { nodes { author { login } body path } } } } } } }",
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${name}`,
      "-F",
      `number=${pullRequestNumber}`,
    ],
    null,
  );

  return result.data.repository.pullRequest.reviewThreads.nodes;
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

  if (summary.unresolvedThreads.length > 0) {
    console.log(
      `Unresolved review threads: ${summary.unresolvedThreads.length}`,
    );
    for (const [index, thread] of summary.unresolvedThreads.entries()) {
      const firstComment = thread.comments[0];
      const author = firstComment?.authorLogin || "unknown";
      const path = firstComment?.path || "(general)";
      const body = (firstComment?.body || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      console.log(
        `  ${index + 1}. ${author} @ ${path}${body ? ` :: ${body}` : ""} [thread=${thread.id}]`,
      );
    }
  }

  if (summary.unknown.length > 0) {
    console.log(`Unknown completed conclusions: ${summary.unknown.length}`);
    for (const check of summary.unknown) {
      console.log(
        `  - ${check.name}: status=${check.status} conclusion=${check.conclusion || "(empty)"}`,
      );
    }
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  while (true) {
    const repo = await resolveRepoName(options.repo);
    const resolvedOptions = { ...options, repo };
    let pullRequest;
    let reviewThreads;

    if (options.pr !== null) {
      [pullRequest, reviewThreads] = await Promise.all([
        resolvePullRequest(resolvedOptions),
        fetchReviewThreads(options.pr, repo),
      ]);
    } else {
      pullRequest = await resolvePullRequest(resolvedOptions);
      reviewThreads = await fetchReviewThreads(pullRequest.number, repo);
    }

    const summary = summarizeChecks(
      pullRequest.statusCheckRollup,
      reviewThreads,
    );
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

    const delayMilliseconds = nextPollDelayMilliseconds({
      startedAt,
      intervalSeconds: options.intervalSeconds,
      timeoutSeconds: options.timeoutSeconds,
    });
    if (delayMilliseconds <= 0) {
      console.error("Timed out waiting for CI to finish");
      process.exitCode = 2;
      return;
    }

    await sleep(delayMilliseconds);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
