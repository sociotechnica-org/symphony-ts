#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeReviewThreads } from "./fix-ci-lib.mjs";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const options = {
    pr: null,
    repo: process.env["GITHUB_REPO"] ?? null,
    dryRun: false,
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
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.pr === null || !Number.isInteger(options.pr) || options.pr <= 0) {
    throw new Error("A positive --pr value is required");
  }
  if (options.repo === null || !options.repo.includes("/")) {
    throw new Error("A repo in owner/name form is required");
  }

  return options;
}

async function ghJson(args) {
  const { stdout } = await execFileAsync("gh", args);
  return JSON.parse(stdout);
}

function parseRepo(repo) {
  const [owner, name] = repo.split("/", 2);
  return { owner, name };
}

async function fetchReviewThreads(pullRequestNumber, repo) {
  const { owner, name } = parseRepo(repo);
  const result = await ghJson([
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
  ]);

  return normalizeReviewThreads(
    result.data.repository.pullRequest.reviewThreads.nodes,
  );
}

async function resolveThread(threadId) {
  const result = await ghJson([
    "api",
    "graphql",
    "-f",
    "query=mutation($threadId:ID!) { resolveReviewThread(input:{threadId:$threadId}) { thread { id isResolved } } }",
    "-F",
    `threadId=${threadId}`,
  ]);

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(
      `Failed to resolve thread ${threadId}: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const resolved = result.data?.resolveReviewThread?.thread?.isResolved;
  if (resolved !== true) {
    throw new Error(`Thread ${threadId} was not marked resolved`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const threads = await fetchReviewThreads(options.pr, options.repo);
  const unresolved = threads.filter(
    (thread) => thread.isResolved !== true && thread.isOutdated !== true,
  );

  if (unresolved.length === 0) {
    console.log("No unresolved non-outdated review threads");
    return;
  }

  for (const [index, thread] of unresolved.entries()) {
    const firstComment = thread.comments[0];
    const author = firstComment?.authorLogin || "unknown";
    const path = firstComment?.path || "(general)";
    const body = (firstComment?.body || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    const action = options.dryRun ? "Would resolve" : "Resolved";

    if (!options.dryRun) {
      await resolveThread(thread.id);
    }

    console.log(
      `${action} ${index + 1}/${unresolved.length}: ${author} @ ${path}${body ? ` :: ${body}` : ""} [thread=${thread.id}]`,
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
