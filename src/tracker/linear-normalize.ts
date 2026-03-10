import type { RuntimeIssue } from "../domain/issue.js";
import { TrackerError } from "../domain/errors.js";
import {
  requireArray,
  requireBoolean,
  requireNullableString,
  requireNumber,
  requireObject,
  requireString,
} from "./linear-parse.js";
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
  if (record["project"] === null || record["project"] === undefined) {
    throw new TrackerError("Linear project not found in issue result");
  }
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
