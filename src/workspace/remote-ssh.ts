import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { WorkspaceError } from "../domain/errors.js";
import type {
  PreparedWorkspace,
  WorkspaceCleanupResult,
  WorkspacePreparationRequest,
  WorkspaceSource,
} from "../domain/workspace.js";
import {
  createConfiguredWorkspaceSource,
  getWorkspaceSourceLocation,
} from "../domain/workspace.js";
import type {
  SshWorkerHostConfig,
  WorkspaceConfig,
} from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import { quoteShellToken } from "../runner/local-command.js";
import { buildSshRemoteCommand } from "../runner/ssh-command.js";
import type { WorkspaceManager } from "./service.js";

const execFileAsync = promisify(execFile);

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function renderRemotePath(
  workerHost: SshWorkerHostConfig,
  workspacePath: string,
): string {
  return `${workerHost.name}:${workspacePath}`;
}

function buildSshArgs(
  workerHost: SshWorkerHostConfig,
  command: string,
): string[] {
  return [
    ...workerHost.sshOptions,
    workerHost.sshDestination,
    buildSshRemoteCommand(["bash", "-lc", command]),
  ];
}

async function runRemoteCommand(
  workerHost: SshWorkerHostConfig,
  command: string,
): Promise<void> {
  try {
    await execFileAsync(
      workerHost.sshExecutable,
      buildSshArgs(workerHost, command),
    );
  } catch (error) {
    throw new WorkspaceError(
      `SSH command failed on worker host '${workerHost.name}'`,
      {
        cause: error as Error,
      },
    );
  }
}

function buildPrepareWorkspaceCommand(input: {
  readonly workspacePath: string;
  readonly branchName: string;
  readonly sourceLocation: string;
  readonly afterCreate: readonly string[];
}): string {
  const workspacePath = quoteShellToken(input.workspacePath);
  const workspaceRoot = quoteShellToken(path.dirname(input.workspacePath));
  const branchName = quoteShellToken(input.branchName);
  const sourceLocation = quoteShellToken(input.sourceLocation);
  const afterCreate =
    input.afterCreate.length === 0 ? "" : `${input.afterCreate.join("\n")}\n`;

  return `set -euo pipefail
workspace_path=${workspacePath}
workspace_root=${workspaceRoot}
branch_name=${branchName}
source_location=${sourceLocation}

mkdir -p "$workspace_root"

if [ ! -d "$workspace_path/.git" ]; then
  git clone "$source_location" "$workspace_path"
  cd "$workspace_path"
${afterCreate}fi

cd "$workspace_path"
git fetch origin
git remote set-head origin --auto >/dev/null 2>&1 || true

default_branch=""
if branch_ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); then
  case "$branch_ref" in
    origin/*)
      default_branch="\${branch_ref#origin/}"
      ;;
  esac
fi

if [ -z "$default_branch" ]; then
  if git show-ref --verify --quiet refs/remotes/origin/main; then
    default_branch=main
  elif git show-ref --verify --quiet refs/remotes/origin/master; then
    default_branch=master
  else
    printf '%s\\n' "Could not resolve the default branch for origin in $workspace_path. Expected refs/remotes/origin/HEAD or a known fallback branch." >&2
    exit 1
  fi
fi

default_branch_ref="origin/$default_branch"
has_local_branch=0
has_remote_branch=0
if git branch --list "$branch_name" | grep -q .; then
  has_local_branch=1
fi
if git branch --remotes --list "origin/$branch_name" | grep -q .; then
  has_remote_branch=1
fi

if [ "$has_remote_branch" -eq 1 ]; then
  git checkout -B "$branch_name"
  git reset --hard "origin/$branch_name"
else
  git checkout -B "$default_branch" "$default_branch_ref"
  git reset --hard "$default_branch_ref"
  if [ "$has_local_branch" -eq 1 ]; then
    git checkout "$branch_name"
    git reset --hard "$default_branch_ref"
  else
    git checkout -b "$branch_name"
  fi
fi
`;
}

function buildCleanupWorkspaceCommand(workspacePath: string): string {
  return `set -euo pipefail
workspace_path=${quoteShellToken(workspacePath)}
if [ -e "$workspace_path" ]; then
  rm -rf "$workspace_path"
  printf 'deleted\\n'
else
  printf 'already-absent\\n'
fi
`;
}

function isWorkerHostRecord(
  workerHosts:
    | Readonly<Record<string, SshWorkerHostConfig>>
    | SshWorkerHostConfig,
): workerHosts is Readonly<Record<string, SshWorkerHostConfig>> {
  return !("sshDestination" in workerHosts);
}

export class RemoteSshWorkspaceManager implements WorkspaceManager {
  readonly #config: WorkspaceConfig;
  readonly #workerHosts: Readonly<Record<string, SshWorkerHostConfig>>;
  readonly #afterCreate: readonly string[];
  readonly #logger: Logger;
  readonly #sourceOverride: WorkspaceSource | null;

  constructor(
    config: WorkspaceConfig,
    workerHosts:
      | Readonly<Record<string, SshWorkerHostConfig>>
      | SshWorkerHostConfig,
    afterCreate: readonly string[],
    logger: Logger,
    sourceOverride?: WorkspaceSource | null,
  ) {
    this.#config = config;
    this.#workerHosts = isWorkerHostRecord(workerHosts)
      ? workerHosts
      : {
          [workerHosts.name]: workerHosts,
        };
    this.#afterCreate = afterCreate;
    this.#logger = logger;
    this.#sourceOverride = sourceOverride ?? null;
  }

  async prepareWorkspace(
    request: WorkspacePreparationRequest,
  ): Promise<PreparedWorkspace> {
    const issue = request.issue;
    const workerHost = this.#resolveWorkerHost(request.workerHost);
    const branchName = `${this.#config.branchPrefix}${issue.number}`;
    const workspacePath = this.#workspacePathForIssue(
      workerHost,
      issue.identifier,
    );
    const effectiveSource =
      this.#resolveWorkspaceSource(workerHost, request.sourceOverride) ??
      createConfiguredWorkspaceSource(this.#config.repoUrl);
    const sourceLocation = getWorkspaceSourceLocation(effectiveSource);

    await runRemoteCommand(
      workerHost,
      buildPrepareWorkspaceCommand({
        workspacePath,
        branchName,
        sourceLocation,
        afterCreate: this.#afterCreate,
      }),
    );

    this.#logger.info("Remote workspace ready", {
      workerHost: workerHost.name,
      workspacePath,
      issueIdentifier: issue.identifier,
      branchName,
      workspaceSourceKind: effectiveSource.kind,
      workspaceSourceLocation: sourceLocation,
    });

    return {
      key: sanitize(issue.identifier),
      branchName,
      createdNow: false,
      source: effectiveSource,
      target: {
        kind: "remote",
        host: workerHost.name,
        workspaceId: `${workerHost.name}:${sanitize(issue.identifier)}`,
        pathHint: workspacePath,
      },
    };
  }

  async cleanupWorkspace(
    workspace: PreparedWorkspace,
  ): Promise<WorkspaceCleanupResult> {
    const workerHost = this.#resolveWorkerHostFromWorkspace(workspace);
    const workspacePath =
      workspace.target.kind === "remote"
        ? (workspace.target.pathHint ?? null)
        : null;
    if (workspacePath === null) {
      throw new WorkspaceError(
        "Remote SSH workspace cleanup requires a remote workspace target with pathHint",
      );
    }
    const result = await execFileAsync(
      workerHost.sshExecutable,
      buildSshArgs(workerHost, buildCleanupWorkspaceCommand(workspacePath)),
    );
    const kind =
      result.stdout.trim() === "deleted" ? "deleted" : "already-absent";
    return {
      kind,
      workspacePath: renderRemotePath(workerHost, workspacePath),
    };
  }

  async cleanupWorkspaceForIssue(
    request: WorkspacePreparationRequest,
  ): Promise<WorkspaceCleanupResult> {
    const workerHost = this.#resolveWorkerHost(request.workerHost);
    return await this.cleanupWorkspace({
      key: sanitize(request.issue.identifier),
      branchName: `${this.#config.branchPrefix}${request.issue.number}`,
      createdNow: false,
      source:
        this.#resolveWorkspaceSource(workerHost, request.sourceOverride) ??
        createConfiguredWorkspaceSource(this.#config.repoUrl),
      target: {
        kind: "remote",
        host: workerHost.name,
        workspaceId: `${workerHost.name}:${sanitize(request.issue.identifier)}`,
        pathHint: this.#workspacePathForIssue(
          workerHost,
          request.issue.identifier,
        ),
      },
    });
  }

  #resolveWorkspaceSource(
    workerHost: SshWorkerHostConfig,
    sourceOverride?: WorkspaceSource | null,
  ): WorkspaceSource | null {
    const source =
      sourceOverride ??
      this.#sourceOverride ??
      createConfiguredWorkspaceSource(this.#config.repoUrl);
    if (source.kind === "configured-repo") {
      return source;
    }
    if (source.kind === "remote-path" && source.host === workerHost.name) {
      return source;
    }
    this.#logger.warn(
      "Ignoring local-only workspace source override for remote SSH workspace",
      {
        workerHost: workerHost.name,
        sourceKind: source.kind,
        sourceLocation: getWorkspaceSourceLocation(source),
      },
    );
    return createConfiguredWorkspaceSource(this.#config.repoUrl);
  }

  #resolveWorkerHost(
    workerHost: SshWorkerHostConfig | null | undefined,
  ): SshWorkerHostConfig {
    if (workerHost !== null && workerHost !== undefined) {
      return workerHost;
    }
    const configuredHosts = Object.values(this.#workerHosts);
    if (configuredHosts.length === 1) {
      return configuredHosts[0]!;
    }
    throw new WorkspaceError(
      "Remote SSH workspace preparation requires an explicit worker host when multiple worker hosts are configured",
    );
  }

  #resolveWorkerHostFromWorkspace(
    workspace: PreparedWorkspace,
  ): SshWorkerHostConfig {
    if (workspace.target.kind !== "remote") {
      throw new WorkspaceError(
        `Remote SSH workspace cleanup requires a remote workspace target, received ${workspace.target.kind}`,
      );
    }
    const workerHost = this.#workerHosts[workspace.target.host];
    if (workerHost === undefined) {
      throw new WorkspaceError(
        `Remote SSH workspace cleanup received unknown worker host '${workspace.target.host}'`,
      );
    }
    return workerHost;
  }

  #workspacePathForIssue(
    workerHost: SshWorkerHostConfig,
    issueIdentifier: string,
  ): string {
    return path.posix.join(workerHost.workspaceRoot, sanitize(issueIdentifier));
  }
}
