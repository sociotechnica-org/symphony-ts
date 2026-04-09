import path from "node:path";
import { ConfigError } from "../domain/errors.js";
import type {
  SshWorkerHostConfig,
  WorkspaceConfig,
  WorkspaceRetentionMode,
} from "../domain/workflow.js";
import {
  coerceOptionalObject,
  requireBoolean,
  requireEnum,
  requireOptionalString,
  requireString,
  requireStringArray,
} from "./workflow-validation.js";

const DEFAULT_WORKSPACE_RETENTION = {
  onSuccess: "delete",
  onFailure: "retain",
} as const satisfies Record<string, WorkspaceRetentionMode>;

export function resolveWorkspaceConfig(args: {
  readonly workspace: Readonly<Record<string, unknown>>;
  readonly instanceRoot: string;
  readonly workflowRoot: string;
  readonly derivedRepoUrl: string | undefined;
  readonly repoOverrideActive: boolean;
}): WorkspaceConfig {
  const root = path.resolve(
    args.instanceRoot,
    requireString(args.workspace["root"], "workspace.root"),
  );
  return {
    root,
    repoUrl: resolveRepoUrl(
      args.workspace["repo_url"],
      args.derivedRepoUrl,
      args.repoOverrideActive,
      args.workflowRoot,
    ),
    branchPrefix: requireString(
      args.workspace["branch_prefix"],
      "workspace.branch_prefix",
    ),
    retention: resolveWorkspaceRetentionPolicy(args.workspace),
    workerHosts: resolveWorkerHostsConfig(args.workspace["worker_hosts"]),
  };
}

function resolveRepoUrl(
  explicitRepoUrl: unknown,
  derivedRepoUrl: string | undefined,
  envOverrideActive: boolean,
  workflowRoot: string,
): string {
  // When SYMPHONY_REPO is set, the derived URL always wins so the factory
  // polls, clones, and pushes to the same repo.
  if (derivedRepoUrl !== undefined && envOverrideActive) {
    if (explicitRepoUrl !== undefined) {
      console.warn(
        `[symphony] SYMPHONY_REPO overrides workspace.repo_url; using ${derivedRepoUrl}`,
      );
    }
    return derivedRepoUrl;
  }

  if (explicitRepoUrl === undefined) {
    if (derivedRepoUrl !== undefined) {
      return derivedRepoUrl;
    }
    const hint = envOverrideActive
      ? " (SYMPHONY_REPO is set but has no effect for this tracker kind)"
      : "";
    throw new ConfigError(
      `workspace.repo_url is required when not using a GitHub-backed tracker${hint}`,
    );
  }

  return resolveWorkspaceRepoUrl(
    requireString(explicitRepoUrl, "workspace.repo_url"),
    workflowRoot,
  );
}

export function resolveWorkspaceRepoUrl(
  repoUrl: string,
  workflowRoot: string,
): string {
  if (isRemoteRepoUrl(repoUrl)) {
    return repoUrl;
  }
  return path.resolve(workflowRoot, repoUrl);
}

function isRemoteRepoUrl(repoUrl: string): boolean {
  if (hasUrlScheme(repoUrl)) {
    return true;
  }
  return isScpStyleRepoUrl(repoUrl);
}

export function isRemoteExecutionRepoUrl(repoUrl: string): boolean {
  if (isScpStyleRepoUrl(repoUrl)) {
    return true;
  }
  if (!hasUrlScheme(repoUrl)) {
    return false;
  }
  try {
    return new URL(repoUrl).protocol !== "file:";
  } catch {
    return true;
  }
}

function hasUrlScheme(repoUrl: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(repoUrl);
}

function isScpStyleRepoUrl(repoUrl: string): boolean {
  return /^[^/\\\s]+@[^:/\\\s]+:.+$/.test(repoUrl);
}

function resolveWorkspaceRetentionPolicy(
  workspace: Readonly<Record<string, unknown>>,
) {
  const rawRetention = workspace["retention"];
  const retention =
    rawRetention === undefined
      ? {}
      : coerceOptionalObject(rawRetention, "workspace.retention");
  const legacyCleanupOnSuccess = workspace["cleanup_on_success"];
  const onSuccess =
    retention["on_success"] === undefined
      ? legacyCleanupOnSuccess === undefined
        ? DEFAULT_WORKSPACE_RETENTION.onSuccess
        : requireBoolean(legacyCleanupOnSuccess, "workspace.cleanup_on_success")
          ? "delete"
          : "retain"
      : requireEnum(
          retention["on_success"],
          ["delete", "retain"],
          "workspace.retention.on_success",
        );
  const onFailure =
    retention["on_failure"] === undefined
      ? DEFAULT_WORKSPACE_RETENTION.onFailure
      : requireEnum(
          retention["on_failure"],
          ["delete", "retain"],
          "workspace.retention.on_failure",
        );
  return {
    onSuccess,
    onFailure,
  } as const;
}

function resolveWorkerHostsConfig(
  raw: unknown,
): Readonly<Record<string, SshWorkerHostConfig>> {
  if (raw === undefined) {
    return {};
  }

  const workerHosts = coerceOptionalObject(raw, "workspace.worker_hosts");
  const resolved = Object.entries(workerHosts).map(([name, value]) => {
    const workerHost = coerceOptionalObject(
      value,
      `workspace.worker_hosts.${name}`,
    );
    return [
      name,
      {
        name,
        sshDestination: requireString(
          workerHost["ssh_destination"],
          `workspace.worker_hosts.${name}.ssh_destination`,
        ),
        sshExecutable:
          requireOptionalString(
            workerHost["ssh_executable"],
            `workspace.worker_hosts.${name}.ssh_executable`,
          ) ?? "ssh",
        sshOptions:
          workerHost["ssh_options"] === undefined
            ? []
            : requireStringArray(
                workerHost["ssh_options"],
                `workspace.worker_hosts.${name}.ssh_options`,
              ),
        workspaceRoot: requireString(
          workerHost["workspace_root"],
          `workspace.worker_hosts.${name}.workspace_root`,
        ),
      } satisfies SshWorkerHostConfig,
    ] as const;
  });

  return Object.fromEntries(resolved);
}
