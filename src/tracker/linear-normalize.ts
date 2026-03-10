import type { RuntimeIssue } from "../domain/issue.js";
import { TrackerError } from "../domain/errors.js";
import {
  parseLinearWorkpad,
  type LinearWorkpadEntry,
} from "./linear-workpad.js";

export interface LinearWorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly position: number;
}

export interface LinearComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly userName: string | null;
  readonly userEmail: string | null;
}

export interface LinearIssueSnapshot {
  readonly id: string;
  readonly identifier: string;
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: LinearWorkflowState;
  readonly comments: readonly LinearComment[];
  readonly workpad: LinearWorkpadEntry | null;
  readonly runtimeIssue: RuntimeIssue;
}

export interface LinearProjectSnapshot {
  readonly id: string;
  readonly slugId: string;
  readonly name: string;
  readonly states: readonly LinearWorkflowState[];
}

export interface LinearIssuePageSnapshot {
  readonly project: LinearProjectSnapshot;
  readonly issues: readonly LinearIssueSnapshot[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface LinearProjectIssuesSnapshot {
  readonly project: LinearProjectSnapshot;
  readonly issues: readonly LinearIssueSnapshot[];
}

export function normalizeLinearProject(value: unknown): LinearProjectSnapshot {
  const record = requireObject(value, "project");
  const statesConnection = requireObject(record["states"], "project.states");
  const states = requireArray(
    statesConnection["nodes"],
    "project.states.nodes",
  ).map((entry, index) =>
    normalizeLinearWorkflowState(entry, `project.states.nodes[${index}]`),
  );

  return {
    id: requireString(record["id"], "project.id"),
    slugId: requireString(record["slugId"], "project.slugId"),
    name: requireString(record["name"], "project.name"),
    states,
  };
}

export function normalizeLinearIssuePage(
  value: unknown,
): LinearIssuePageSnapshot {
  const record = requireObject(value, "page");
  const projectRecord = requireObject(record["project"], "project");
  const project = normalizeLinearProject(projectRecord);
  const issuesConnection = requireObject(
    projectRecord["issues"],
    "project.issues",
  );
  const issues = requireArray(
    issuesConnection["nodes"],
    "project.issues.nodes",
  ).map((entry, index) =>
    normalizeLinearIssue(entry, `project.issues.nodes[${index}]`),
  );
  const pageInfo = requireObject(
    issuesConnection["pageInfo"],
    "project.issues.pageInfo",
  );

  return {
    project,
    issues,
    hasNextPage: requireBoolean(
      pageInfo["hasNextPage"],
      "project.issues.pageInfo.hasNextPage",
    ),
    endCursor: requireNullableString(
      pageInfo["endCursor"],
      "project.issues.pageInfo.endCursor",
    ),
  };
}

export function normalizeLinearProjectIssuesResult(
  value: unknown,
): LinearProjectIssuesSnapshot {
  const record = requireObject(value, "projectIssues");
  const issues = requireArray(record["issues"], "projectIssues.issues").map(
    (entry, index) =>
      normalizeLinearIssue(entry, `projectIssues.issues[${index}]`),
  );

  return {
    project: normalizeLinearProject(record["project"]),
    issues,
  };
}

export function normalizeLinearIssueResult(value: unknown): {
  readonly project: LinearProjectSnapshot;
  readonly issue: LinearIssueSnapshot | null;
} {
  const record = requireObject(value, "projectIssue");
  const projectRecord = requireObject(record["project"], "project");

  return {
    project: normalizeLinearProject(projectRecord),
    issue:
      projectRecord["issue"] === null || projectRecord["issue"] === undefined
        ? null
        : normalizeLinearIssue(projectRecord["issue"], "project.issue"),
  };
}

export function normalizeLinearIssueMutationResult(
  value: unknown,
  field: "issueUpdate" | "commentCreate",
): LinearIssueSnapshot {
  const root = requireObject(value, field);
  const mutation = requireObject(root[field], field);
  const success = requireBoolean(mutation["success"], `${field}.success`);
  if (!success) {
    throw new TrackerError(`Linear mutation ${field} reported success=false`);
  }
  return normalizeLinearIssue(mutation["issue"], `${field}.issue`);
}

function normalizeLinearIssue(
  value: unknown,
  field: string,
): LinearIssueSnapshot {
  const record = requireObject(value, field);
  const description = requireNullableString(
    record["description"],
    `${field}.description`,
  );
  const commentsConnection = requireObject(
    record["comments"],
    `${field}.comments`,
  );
  const comments = requireArray(
    commentsConnection["nodes"],
    `${field}.comments.nodes`,
  ).map((entry, index) =>
    normalizeLinearComment(entry, `${field}.comments.nodes[${index}]`),
  );
  const workpad = parseLinearWorkpad(description);

  const runtimeIssue: RuntimeIssue = {
    id: requireString(record["id"], `${field}.id`),
    identifier: requireString(record["identifier"], `${field}.identifier`),
    number: requireNumber(record["number"], `${field}.number`),
    title: requireString(record["title"], `${field}.title`),
    description: description ?? "",
    labels: [],
    state: requireString(
      requireObject(record["state"], `${field}.state`)["name"],
      `${field}.state.name`,
    ),
    url: requireString(record["url"], `${field}.url`),
    createdAt: requireString(record["createdAt"], `${field}.createdAt`),
    updatedAt: requireString(record["updatedAt"], `${field}.updatedAt`),
  };

  return {
    id: runtimeIssue.id,
    identifier: runtimeIssue.identifier,
    number: runtimeIssue.number,
    title: runtimeIssue.title,
    description: runtimeIssue.description,
    url: runtimeIssue.url,
    createdAt: runtimeIssue.createdAt,
    updatedAt: runtimeIssue.updatedAt,
    state: normalizeLinearWorkflowState(record["state"], `${field}.state`),
    comments,
    workpad,
    runtimeIssue,
  };
}

function normalizeLinearWorkflowState(
  value: unknown,
  field: string,
): LinearWorkflowState {
  const record = requireObject(value, field);
  return {
    id: requireString(record["id"], `${field}.id`),
    name: requireString(record["name"], `${field}.name`),
    type: requireString(record["type"], `${field}.type`),
    position: requireNumber(record["position"], `${field}.position`),
  };
}

function normalizeLinearComment(value: unknown, field: string): LinearComment {
  const record = requireObject(value, field);
  const user =
    record["user"] === null || record["user"] === undefined
      ? null
      : requireObject(record["user"], `${field}.user`);

  return {
    id: requireString(record["id"], `${field}.id`),
    body: requireString(record["body"], `${field}.body`),
    createdAt: requireString(record["createdAt"], `${field}.createdAt`),
    userName:
      user === null
        ? null
        : requireNullableString(user["name"], `${field}.user.name`),
    userEmail:
      user === null
        ? null
        : requireNullableString(user["email"], `${field}.user.email`),
  };
}

function requireObject(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TrackerError(`Expected object for ${field}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TrackerError(`Expected array for ${field}`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TrackerError(`Expected non-empty string for ${field}`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TrackerError(`Expected string or null for ${field}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TrackerError(`Expected number for ${field}`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new TrackerError(`Expected boolean for ${field}`);
  }
  return value;
}
