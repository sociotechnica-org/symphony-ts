import type { RuntimeIssue } from "./issue.js";

export interface ConfiguredWorkspaceSource {
  readonly kind: "configured-repo";
  readonly repoUrl: string;
}

export interface LocalPathWorkspaceSource {
  readonly kind: "local-path";
  readonly path: string;
}

export interface RemoteWorkspaceSource {
  readonly kind: "remote-path";
  readonly host: string;
  readonly path: string;
}

export type WorkspaceSource =
  | ConfiguredWorkspaceSource
  | LocalPathWorkspaceSource
  | RemoteWorkspaceSource;

export interface WorkspacePreparationRequest {
  readonly issue: RuntimeIssue;
  readonly sourceOverride?: WorkspaceSource | null;
}

export interface LocalWorkspaceTarget {
  readonly kind: "local";
  readonly path: string;
}

export interface RemoteWorkspaceTarget {
  readonly kind: "remote";
  readonly host: string;
  readonly workspaceId: string;
  readonly pathHint?: string | null;
}

export type WorkspaceTarget = LocalWorkspaceTarget | RemoteWorkspaceTarget;

export interface PreparedWorkspace {
  readonly key: string;
  /** Canonical issue branch checked out for the run. */
  readonly branchName: string;
  readonly createdNow: boolean;
  readonly source: WorkspaceSource;
  readonly target: WorkspaceTarget;
}

export interface WorkspaceCleanupResult {
  readonly kind: "deleted" | "already-absent";
  readonly workspacePath: string;
}

export function createConfiguredWorkspaceSource(
  repoUrl: string,
): ConfiguredWorkspaceSource {
  return {
    kind: "configured-repo",
    repoUrl,
  };
}

export function getWorkspaceSourceLocation(source: WorkspaceSource): string {
  switch (source.kind) {
    case "configured-repo":
      return source.repoUrl;
    case "local-path":
      return source.path;
    case "remote-path":
      return `${source.host}:${source.path}`;
  }
}

export function getWorkspaceTargetPath(target: WorkspaceTarget): string | null {
  if (target.kind !== "local") {
    return null;
  }
  return target.path;
}

export function getPreparedWorkspacePath(
  workspace: PreparedWorkspace,
): string | null {
  return getWorkspaceTargetPath(workspace.target);
}
