import path from "node:path";
import { ConfigError } from "../domain/errors.js";
import {
  deriveInstanceRootFromWorkflowPath,
  deriveRuntimeInstancePaths,
  type ResolvedConfig,
} from "../domain/workflow.js";
import {
  resolveAgentConfig,
  validateRemoteExecutionConfig,
} from "./workflow-section-agent.js";
import { resolveHooksConfig } from "./workflow-section-hooks.js";
import { resolveObservabilityConfig } from "./workflow-section-observability.js";
import { resolvePollingConfig } from "./workflow-section-polling.js";
import { resolveWorkspaceConfig } from "./workflow-section-workspace.js";
import type { RawWorkflow } from "./workflow-source.js";
import { coerceOptionalObject, requireString } from "./workflow-validation.js";
import {
  isGitHubTrackerConfig,
  resolveTrackerConfig,
} from "./workflow-tracker-config.js";

export function resolveConfig(
  raw: RawWorkflow,
  workflowPath: string,
): ResolvedConfig {
  const resolvedWorkflowPath = path.resolve(workflowPath);
  const workflowRoot = path.dirname(resolvedWorkflowPath);
  const instanceRoot = deriveInstanceRootFromWorkflowPath(resolvedWorkflowPath);
  const tracker = coerceOptionalObject(raw.tracker, "tracker");
  const polling = coerceOptionalObject(raw.polling, "polling");
  const workspace = coerceOptionalObject(raw.workspace, "workspace");
  const hooks = coerceOptionalObject(raw.hooks, "hooks");
  const agent = coerceOptionalObject(raw.agent, "agent");
  const observabilityRaw =
    raw.observability === null
      ? {}
      : coerceOptionalObject(raw.observability, "observability");

  // Apply SYMPHONY_REPO env override (GitHub-backed trackers only; ignored by other tracker kinds)
  const rawRepoEnv = process.env["SYMPHONY_REPO"];
  const repoOverride =
    rawRepoEnv !== undefined
      ? requireString(rawRepoEnv, "SYMPHONY_REPO env var")
      : undefined;
  const rawTrackerRepo = tracker["repo"];
  const effectiveTracker =
    repoOverride !== undefined ? { ...tracker, repo: repoOverride } : tracker;

  if (
    repoOverride !== undefined &&
    typeof rawTrackerRepo === "string" &&
    rawTrackerRepo.trim() !== repoOverride
  ) {
    console.warn(
      `[symphony] SYMPHONY_REPO="${repoOverride}" overrides tracker.repo="${rawTrackerRepo.trim()}" from WORKFLOW.md`,
    );
  }

  const resolvedTracker = resolveTrackerConfig(effectiveTracker);

  if (repoOverride !== undefined && !isGitHubTrackerConfig(resolvedTracker)) {
    console.warn(
      `[symphony] SYMPHONY_REPO is set but ignored for tracker.kind="${resolvedTracker.kind}"`,
    );
  }

  // For GitHub-backed trackers, derive repoUrl and inject GITHUB_REPO.
  let derivedRepoUrl: string | undefined;
  let repo: string | undefined;
  if (isGitHubTrackerConfig(resolvedTracker)) {
    repo = resolvedTracker.repo;
    try {
      const gitHost = new URL(resolvedTracker.apiUrl).hostname.replace(
        /^api\./,
        "",
      );
      derivedRepoUrl = `git@${gitHost}:${repo}.git`;
    } catch {
      throw new ConfigError(
        `tracker.api_url is not a valid URL: ${resolvedTracker.apiUrl}`,
      );
    }
  }

  const resolvedWorkspace = resolveWorkspaceConfig({
    workspace,
    instanceRoot,
    workflowRoot,
    derivedRepoUrl,
    repoOverrideActive: repoOverride !== undefined,
  });
  const resolved: ResolvedConfig = {
    workflowPath: resolvedWorkflowPath,
    instance: deriveRuntimeInstancePaths({
      workflowPath: resolvedWorkflowPath,
      workspaceRoot: resolvedWorkspace.root,
    }),
    tracker: resolvedTracker,
    polling: resolvePollingConfig(polling),
    workspace: resolvedWorkspace,
    hooks: resolveHooksConfig(hooks),
    agent: resolveAgentConfig({
      agent,
      repo,
      workerHosts: resolvedWorkspace.workerHosts,
    }),
    observability: resolveObservabilityConfig(observabilityRaw, instanceRoot),
  };

  if (resolved.polling.maxConcurrentRuns < 1) {
    throw new ConfigError("polling.max_concurrent_runs must be >= 1");
  }

  if (resolved.polling.retry.maxAttempts < 1) {
    throw new ConfigError("polling.retry.max_attempts must be >= 1");
  }

  validateRemoteExecutionConfig(resolved);
  return resolved;
}
