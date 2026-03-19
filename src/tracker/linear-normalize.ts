import type { RuntimeIssue } from "../domain/issue.js";
import { TrackerError } from "../domain/errors.js";
import type { QueuePriorityConfig } from "../domain/workflow.js";
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
import { normalizeLinearQueuePriority } from "./linear-queue-priority.js";

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

export interface LinearIssueAssigneeSnapshot {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
}

export interface LinearIssueRelationSnapshot {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly state: string;
}

export interface LinearIssueNormalizationOptions {
  readonly configuredAssignee: string | null;
  readonly queuePriority?: QueuePriorityConfig | undefined;
}

export interface LinearIssueSnapshot {
  readonly id: string;
  readonly identifier: string;
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly priority: number | null;
  readonly branchName: string | null;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: LinearWorkflowState;
  readonly assignee: LinearIssueAssigneeSnapshot | null;
  readonly assignedToWorker: boolean;
  readonly labels: readonly string[];
  readonly blockedBy: readonly LinearIssueRelationSnapshot[];
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

const DEFAULT_OPTIONS: LinearIssueNormalizationOptions = {
  configuredAssignee: null,
  queuePriority: undefined,
};

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
  options: LinearIssueNormalizationOptions = DEFAULT_OPTIONS,
): LinearProjectIssuesSnapshot {
  const record = requireObject(value, "projectIssues");
  const issues = requireArray(record["issues"], "projectIssues.issues").map(
    (entry, index) =>
      normalizeLinearIssueSnapshot(
        entry,
        `projectIssues.issues[${index}]`,
        options,
      ),
  );

  return {
    project: normalizeLinearProject(record["project"]),
    issues,
  };
}

export function normalizeLinearIssueResult(
  value: unknown,
  options: LinearIssueNormalizationOptions = DEFAULT_OPTIONS,
): {
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
        : normalizeLinearIssueSnapshot(
            projectRecord["issue"],
            "project.issue",
            options,
          ),
  };
}

export function normalizeLinearIssueMutationResult(
  value: unknown,
  field: "issueUpdate" | "commentCreate",
  options: LinearIssueNormalizationOptions = DEFAULT_OPTIONS,
): LinearIssueSnapshot {
  const root = requireObject(value, field);
  const mutation = requireObject(root[field], field);
  const success = requireBoolean(mutation["success"], `${field}.success`);
  if (!success) {
    throw new TrackerError(`Linear mutation ${field} reported success=false`);
  }
  if (mutation["issue"] === null || mutation["issue"] === undefined) {
    throw new TrackerError(
      `Linear mutation ${field} reported success=true but returned no issue`,
    );
  }
  return normalizeLinearIssueSnapshot(
    mutation["issue"],
    `${field}.issue`,
    options,
  );
}

/**
 * Normalize a raw Linear issue payload into a stable adapter snapshot.
 *
 * `options.configuredAssignee` controls the derived `assignedToWorker` flag:
 * - `null` or blank (default) means no worker filter is configured, so
 *   `assignedToWorker` is always `true`
 * - a non-empty string matches only normalized assignee `id` or `email`
 */
export function normalizeLinearIssueSnapshot(
  value: unknown,
  field: string,
  options: LinearIssueNormalizationOptions = DEFAULT_OPTIONS,
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
  const state = normalizeLinearWorkflowState(record["state"], `${field}.state`);
  const assignee = normalizeLinearAssignee(
    record["assignee"],
    `${field}.assignee`,
  );
  const labels = normalizeLinearLabels(record["labels"], `${field}.labels`);
  const blockedBy = normalizeLinearBlockedBy(
    record["inverseRelations"],
    `${field}.inverseRelations`,
  );
  const normalizedDescription = description ?? "";
  const workpad = parseLinearWorkpad(description);
  const priority = normalizeLinearPriority(
    record["priority"],
    `${field}.priority`,
  );

  const runtimeIssue: RuntimeIssue = {
    id: requireString(record["id"], `${field}.id`),
    identifier: requireString(record["identifier"], `${field}.identifier`),
    number: requireNumber(record["number"], `${field}.number`),
    title: requireString(record["title"], `${field}.title`),
    description: normalizedDescription,
    labels,
    state: state.name,
    url: requireString(record["url"], `${field}.url`),
    createdAt: requireString(record["createdAt"], `${field}.createdAt`),
    updatedAt: requireString(record["updatedAt"], `${field}.updatedAt`),
    queuePriority: normalizeLinearQueuePriority(
      priority,
      options.queuePriority,
    ),
  };

  return {
    id: runtimeIssue.id,
    identifier: runtimeIssue.identifier,
    number: runtimeIssue.number,
    title: runtimeIssue.title,
    description: runtimeIssue.description,
    priority,
    branchName: requireNullableString(
      record["branchName"],
      `${field}.branchName`,
    ),
    url: runtimeIssue.url,
    createdAt: runtimeIssue.createdAt,
    updatedAt: runtimeIssue.updatedAt,
    state,
    assignee,
    assignedToWorker: matchesConfiguredAssignee(
      assignee,
      options.configuredAssignee,
    ),
    labels,
    blockedBy,
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

function normalizeLinearAssignee(
  value: unknown,
  field: string,
): LinearIssueAssigneeSnapshot | null {
  if (value === null || value === undefined) {
    return null;
  }

  const record = requireObject(value, field);
  return {
    id: requireString(record["id"], `${field}.id`),
    name: requireNullableString(record["name"], `${field}.name`),
    email: requireNullableString(record["email"], `${field}.email`),
  };
}

function normalizeLinearLabels(
  value: unknown,
  field: string,
): readonly string[] {
  if (value === null || value === undefined) {
    return [];
  }

  const connection = requireObject(value, field);
  return requireArray(connection["nodes"], `${field}.nodes`).flatMap(
    (entry, index) => {
      if (entry === null || entry === undefined) {
        return [];
      }
      const record = requireObject(entry, `${field}.nodes[${index}]`);
      const name = requireNullableString(
        record["name"],
        `${field}.nodes[${index}].name`,
      );
      const normalized = normalizeLabel(name);
      return normalized === null ? [] : [normalized];
    },
  );
}

function normalizeLinearBlockedBy(
  value: unknown,
  field: string,
): readonly LinearIssueRelationSnapshot[] {
  if (value === null || value === undefined) {
    return [];
  }

  const connection = requireObject(value, field);
  const nodes = requireArray(connection["nodes"], `${field}.nodes`);
  const blockedBy: LinearIssueRelationSnapshot[] = [];

  for (const [index, entry] of nodes.entries()) {
    if (
      entry === null ||
      entry === undefined ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      continue;
    }
    const relation = entry as Record<string, unknown>;
    if (relation["type"] !== "blocks") {
      continue;
    }
    if (relation["issue"] === null || relation["issue"] === undefined) {
      continue;
    }

    const issueField = `${field}.nodes[${index}].issue`;
    const issue = requireObject(relation["issue"], issueField);
    const state = requireObject(issue["state"], `${issueField}.state`);
    blockedBy.push({
      id: requireString(issue["id"], `${issueField}.id`),
      identifier: requireString(
        issue["identifier"],
        `${issueField}.identifier`,
      ),
      title: requireString(issue["title"], `${issueField}.title`),
      state: requireString(state["name"], `${issueField}.state.name`),
    });
  }

  return blockedBy;
}

function normalizeLinearPriority(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = requireNumber(value, field);
  if (normalized === 0) {
    return null;
  }
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 4) {
    throw new TrackerError(
      `Expected Linear priority in range 1-4 or 0 for ${field}, got ${normalized}`,
    );
  }
  return normalized;
}

function matchesConfiguredAssignee(
  assignee: LinearIssueAssigneeSnapshot | null,
  configuredAssignee: string | null,
): boolean {
  if (configuredAssignee === null || configuredAssignee.trim() === "") {
    return true;
  }
  if (assignee === null) {
    return false;
  }

  const normalizedConfiguredAssignee = normalizeAssigneeKey(configuredAssignee);
  return [assignee.id, assignee.email].some(
    (value) =>
      value !== null &&
      normalizeAssigneeKey(value) === normalizedConfiguredAssignee,
  );
}

function normalizeAssigneeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeLabel(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}
