import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

interface MockLinearProject {
  readonly id: string;
  readonly slugId: string;
  readonly name: string;
  readonly states: MockLinearWorkflowState[];
}

interface MockLinearWorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly position: number;
}

interface MockLinearIssue {
  readonly id: string;
  readonly projectId: string;
  readonly number: number;
  readonly identifier: string;
  title: string;
  description: string;
  readonly url: string;
  readonly createdAt: string;
  updatedAt: string;
  stateId: string;
  readonly assignee: MockLinearAssignee | null;
  readonly labels: readonly string[];
  readonly priority: number | null;
  readonly branchName: string | null;
  readonly inverseRelations: readonly MockLinearIssueRelation[];
  readonly comments: MockLinearComment[];
}

interface MockLinearComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly user: {
    readonly name: string | null;
    readonly email: string | null;
  };
}

interface MockLinearAssignee {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
}

interface MockLinearIssueRelation {
  readonly type: string;
  readonly issueId: string | null;
}

interface MockLinearRequest {
  readonly operationName: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly authorization: string | null;
  readonly contentType: string | null;
}

type MockOperationFailure =
  | {
      readonly kind: "graphql";
      readonly messages: readonly string[];
    }
  | {
      readonly kind: "http";
      readonly statusCode: number;
      readonly body: unknown;
    };

const PAGE_SIZE = 2;

function json(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? {} : JSON.parse(raw);
}

export class MockLinearServer {
  readonly #projects = new Map<string, MockLinearProject>();
  readonly #issues = new Map<string, MockLinearIssue>();
  readonly #issuesByNumber = new Map<string, MockLinearIssue>();
  readonly #requests: MockLinearRequest[] = [];
  readonly #failures = new Map<string, MockOperationFailure[]>();
  readonly #server = http.createServer((req, res) => {
    this.#handle(req, res).catch((error: unknown) => {
      console.error("Mock Linear server handler error:", error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  #baseUrl = "";
  #forceNullEndCursorWithNextPage = false;

  async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Mock Linear server failed to bind");
    }
    this.#baseUrl = `http://127.0.0.1:${address.port}/graphql`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    this.#server.close();
    await once(this.#server, "close");
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  seedProject(input: {
    readonly slugId: string;
    readonly name: string;
    readonly states: ReadonlyArray<{
      readonly id?: string;
      readonly name: string;
      readonly type: string;
      readonly position?: number;
    }>;
  }): MockLinearProject {
    const project: MockLinearProject = {
      id: randomUUID(),
      slugId: input.slugId,
      name: input.name,
      states: input.states.map((state, index) => ({
        id: state.id ?? randomUUID(),
        name: state.name,
        type: state.type,
        position: state.position ?? index,
      })),
    };
    this.#projects.set(project.slugId, project);
    return project;
  }

  /**
   * Seed a mock issue.
   *
   * When `inverseRelations` references other issues by `issueNumber`, those
   * issues must already exist in the same project before this call.
   */
  seedIssue(input: {
    readonly projectSlug: string;
    readonly number: number;
    readonly title: string;
    readonly description?: string;
    readonly stateName: string;
    readonly assigneeId?: string | null;
    readonly assigneeName?: string | null;
    readonly assigneeEmail?: string | null;
    readonly labels?: readonly string[];
    readonly priority?: number | null;
    readonly branchName?: string | null;
    readonly inverseRelations?: ReadonlyArray<{
      readonly type: string;
      readonly issueNumber?: number | null;
    }>;
    readonly identifier?: string;
  }): MockLinearIssue {
    const project = this.#requireProject(input.projectSlug);
    const state = this.#requireProjectState(project, input.stateName);
    const now = new Date().toISOString();
    const identifier =
      input.identifier ?? `${project.slugId.toUpperCase()}-${input.number}`;
    const issue: MockLinearIssue = {
      id: randomUUID(),
      projectId: project.id,
      number: input.number,
      identifier,
      title: input.title,
      description: input.description ?? "",
      url: `${this.#baseUrl.replace(/\/graphql$/u, "")}/issues/${identifier}`,
      createdAt: now,
      updatedAt: now,
      stateId: state.id,
      assignee:
        input.assigneeEmail == null &&
        input.assigneeId == null &&
        input.assigneeName == null
          ? null
          : {
              id: input.assigneeId ?? randomUUID(),
              name: input.assigneeName ?? null,
              email: input.assigneeEmail ?? null,
            },
      labels: input.labels ?? [],
      priority: input.priority ?? null,
      branchName: input.branchName ?? null,
      inverseRelations: (input.inverseRelations ?? []).map((relation) => ({
        type: relation.type,
        issueId:
          relation.issueNumber === undefined || relation.issueNumber === null
            ? null
            : this.#requireIssue(input.projectSlug, relation.issueNumber).id,
      })),
      comments: [],
    };
    this.#issues.set(issue.id, issue);
    this.#issuesByNumber.set(
      this.#issueKey(project.slugId, issue.number),
      issue,
    );
    return issue;
  }

  getIssue(
    projectSlug: string,
    issueNumber: number,
  ): {
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly stateName: string;
    readonly labels: readonly string[];
    readonly branchName: string | null;
    readonly priority: number | null;
    readonly comments: readonly string[];
  } {
    const issue = this.#requireIssue(projectSlug, issueNumber);
    const project = this.#requireProject(projectSlug);
    return {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      stateName: this.#requireStateById(project, issue.stateId).name,
      labels: issue.labels,
      branchName: issue.branchName,
      priority: issue.priority,
      comments: issue.comments.map((comment) => comment.body),
    };
  }

  addComment(input: {
    readonly projectSlug: string;
    readonly issueNumber: number;
    readonly body: string;
    readonly createdAt?: string;
    readonly userName?: string | null;
    readonly userEmail?: string | null;
  }): void {
    const issue = this.#requireIssue(input.projectSlug, input.issueNumber);
    issue.comments.push({
      id: randomUUID(),
      body: input.body,
      createdAt: input.createdAt ?? new Date().toISOString(),
      user: {
        name: input.userName ?? "Reviewer",
        email: input.userEmail ?? "reviewer@example.test",
      },
    });
    issue.updatedAt = new Date().toISOString();
  }

  updateIssueState(
    projectSlug: string,
    issueNumber: number,
    stateName: string,
  ): void {
    const issue = this.#requireIssue(projectSlug, issueNumber);
    const project = this.#requireProject(projectSlug);
    issue.stateId = this.#requireProjectState(project, stateName).id;
    issue.updatedAt = new Date().toISOString();
  }

  countRequests(operationName: string): number {
    return this.#requests.filter(
      (request) => request.operationName === operationName,
    ).length;
  }

  requests(operationName?: string): readonly MockLinearRequest[] {
    return operationName === undefined
      ? [...this.#requests]
      : this.#requests.filter(
          (request) => request.operationName === operationName,
        );
  }

  enqueueGraphQLError(operationName: string, message: string): void {
    this.#enqueueFailure(operationName, {
      kind: "graphql",
      messages: [message],
    });
  }

  enqueueHttpError(
    operationName: string,
    statusCode: number,
    body: unknown,
  ): void {
    this.#enqueueFailure(operationName, {
      kind: "http",
      statusCode,
      body,
    });
  }

  forceNullEndCursorWithNextPage(): void {
    this.#forceNullEndCursorWithNextPage = true;
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST" || request.url !== "/graphql") {
      json(response, 404, { error: "not found" });
      return;
    }

    const auth = request.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
      json(response, 401, { errors: [{ message: "missing authorization" }] });
      return;
    }

    const body = await readJson(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      json(response, 400, { errors: [{ message: "invalid graphql payload" }] });
      return;
    }

    const payload = body as Record<string, unknown>;
    const operationName =
      typeof payload["operationName"] === "string"
        ? payload["operationName"]
        : null;
    const query = typeof payload["query"] === "string" ? payload["query"] : "";
    const variables =
      payload["variables"] !== null &&
      typeof payload["variables"] === "object" &&
      !Array.isArray(payload["variables"])
        ? (payload["variables"] as Record<string, unknown>)
        : {};

    if (operationName === null) {
      json(response, 400, { errors: [{ message: "missing operationName" }] });
      return;
    }

    this.#requests.push({
      operationName,
      query,
      variables,
      authorization:
        typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : null,
      contentType:
        typeof request.headers["content-type"] === "string"
          ? request.headers["content-type"]
          : null,
    });

    const failure = this.#shiftFailure(operationName);
    if (failure?.kind === "http") {
      json(response, failure.statusCode, failure.body);
      return;
    }
    if (failure?.kind === "graphql") {
      json(response, 200, {
        errors: failure.messages.map((message) => ({ message })),
      });
      return;
    }

    switch (operationName) {
      case "GetProject":
        json(response, 200, {
          data: {
            project: this.#serializeProject(
              this.#requireProject(
                requireString(variables["slugId"], "slugId"),
              ),
            ),
          },
        });
        return;
      case "GetProjectIssuesPage":
        json(response, 200, {
          data: this.#handleProjectIssuesPage(variables),
        });
        return;
      case "GetProjectIssue":
        json(response, 200, {
          data: this.#handleProjectIssue(variables),
        });
        return;
      case "UpdateIssue":
      case "UpdateIssueDescription":
      case "UpdateIssueState":
      case "UpdateIssueDescriptionAndState":
        json(response, 200, {
          data: {
            issueUpdate: this.#handleIssueUpdate(variables),
          },
        });
        return;
      case "CreateComment":
        json(response, 200, {
          data: {
            commentCreate: this.#handleCommentCreate(variables),
          },
        });
        return;
      default:
        json(response, 400, {
          errors: [{ message: `unsupported operation ${operationName}` }],
        });
    }
  }

  #handleProjectIssuesPage(variables: Readonly<Record<string, unknown>>) {
    const project = this.#requireProject(
      requireString(variables["slugId"], "slugId"),
    );
    const after = requireOptionalString(variables["after"], "after");
    const issues = this.#projectIssues(project.slugId);

    const startIndex =
      after === null ? 0 : issues.findIndex((issue) => issue.id === after) + 1;
    const pageIssues = issues.slice(startIndex, startIndex + PAGE_SIZE);
    const hasNextPage = startIndex + PAGE_SIZE < issues.length;
    const endCursor =
      this.#forceNullEndCursorWithNextPage && hasNextPage
        ? null
        : pageIssues.length === 0
          ? null
          : pageIssues[pageIssues.length - 1]!.id;

    return {
      project: {
        ...this.#serializeProject(project),
        issues: {
          nodes: pageIssues.map((issue) =>
            this.#serializeIssue(project, issue),
          ),
          pageInfo: {
            hasNextPage,
            endCursor,
          },
        },
      },
    };
  }

  #handleProjectIssue(variables: Readonly<Record<string, unknown>>) {
    const slugId = requireString(variables["slugId"], "slugId");
    const project = this.#requireProject(slugId);
    const issueNumber = requireNumber(variables["number"], "number");
    const issue =
      this.#issuesByNumber.get(this.#issueKey(slugId, issueNumber)) ?? null;

    return {
      project: {
        ...this.#serializeProject(project),
        issue: issue === null ? null : this.#serializeIssue(project, issue),
      },
    };
  }

  #handleIssueUpdate(variables: Readonly<Record<string, unknown>>) {
    const issue = this.#requireIssueById(requireString(variables["id"], "id"));
    if ("description" in variables) {
      const description = requireNullableString(
        variables["description"],
        "description",
      );
      issue.description = description ?? "";
    }

    if ("stateId" in variables && variables["stateId"] !== null) {
      const stateId = requireString(variables["stateId"], "stateId");
      const project = this.#projectForIssue(issue);
      this.#requireStateById(project, stateId);
      issue.stateId = stateId;
    }
    issue.updatedAt = new Date().toISOString();

    const project = this.#projectForIssue(issue);
    return {
      success: true,
      issue: this.#serializeIssue(project, issue),
    };
  }

  #handleCommentCreate(variables: Readonly<Record<string, unknown>>) {
    const issue = this.#requireIssueById(
      requireString(variables["issueId"], "issueId"),
    );
    issue.comments.push({
      id: randomUUID(),
      body: requireString(variables["body"], "body"),
      createdAt: new Date().toISOString(),
      user: {
        name: "Symphony",
        email: "symphony@example.test",
      },
    });
    issue.updatedAt = new Date().toISOString();
    const project = this.#projectForIssue(issue);
    return {
      success: true,
      issue: this.#serializeIssue(project, issue),
    };
  }

  #serializeProject(project: MockLinearProject) {
    return {
      id: project.id,
      slugId: project.slugId,
      name: project.name,
      states: {
        nodes: project.states.map((state) => ({
          id: state.id,
          name: state.name,
          type: state.type,
          position: state.position,
        })),
      },
    };
  }

  #serializeIssue(project: MockLinearProject, issue: MockLinearIssue) {
    const state = this.#requireStateById(project, issue.stateId);
    return {
      id: issue.id,
      identifier: issue.identifier,
      number: issue.number,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      branchName: issue.branchName,
      url: issue.url,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      assignee:
        issue.assignee === null
          ? null
          : {
              id: issue.assignee.id,
              name: issue.assignee.name,
              email: issue.assignee.email,
            },
      labels: {
        nodes: issue.labels.map((name) => ({
          name,
        })),
      },
      inverseRelations: {
        nodes: issue.inverseRelations.map((relation) => ({
          type: relation.type,
          issue:
            relation.issueId === null
              ? null
              : this.#serializeRelationIssue(relation.issueId),
        })),
      },
      state: {
        id: state.id,
        name: state.name,
        type: state.type,
        position: state.position,
      },
      comments: {
        nodes: issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          user: {
            name: comment.user.name,
            email: comment.user.email,
          },
        })),
      },
    };
  }

  #serializeRelationIssue(issueId: string) {
    const issue = this.#requireIssueById(issueId);
    const project = this.#projectForIssue(issue);
    const state = this.#requireStateById(project, issue.stateId);
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: {
        name: state.name,
      },
    };
  }

  #projectIssues(projectSlug: string): readonly MockLinearIssue[] {
    const project = this.#requireProject(projectSlug);
    return [...this.#issues.values()]
      .filter((issue) => issue.projectId === project.id)
      .sort((left, right) => left.number - right.number);
  }

  #projectForIssue(issue: MockLinearIssue): MockLinearProject {
    const project = [...this.#projects.values()].find(
      (entry) => entry.id === issue.projectId,
    );
    if (project === undefined) {
      throw new Error(`Project ${issue.projectId} not found`);
    }
    return project;
  }

  #requireProject(projectSlug: string): MockLinearProject {
    const project = this.#projects.get(projectSlug);
    if (project === undefined) {
      throw new Error(`Linear project ${projectSlug} not found`);
    }
    return project;
  }

  #requireIssue(projectSlug: string, issueNumber: number): MockLinearIssue {
    const issue = this.#issuesByNumber.get(
      this.#issueKey(projectSlug, issueNumber),
    );
    if (issue === undefined) {
      throw new Error(
        `Linear issue ${projectSlug}#${issueNumber.toString()} not found`,
      );
    }
    return issue;
  }

  #requireIssueById(issueId: string): MockLinearIssue {
    const issue = this.#issues.get(issueId);
    if (issue === undefined) {
      throw new Error(`Linear issue ${issueId} not found`);
    }
    return issue;
  }

  #requireProjectState(
    project: MockLinearProject,
    stateName: string,
  ): MockLinearWorkflowState {
    const state = project.states.find((entry) => entry.name === stateName);
    if (state === undefined) {
      throw new Error(
        `Linear state '${stateName}' not found in project ${project.slugId}`,
      );
    }
    return state;
  }

  #requireStateById(
    project: MockLinearProject,
    stateId: string,
  ): MockLinearWorkflowState {
    const state = project.states.find((entry) => entry.id === stateId);
    if (state === undefined) {
      throw new Error(
        `Linear state ${stateId} not found in project ${project.slugId}`,
      );
    }
    return state;
  }

  #issueKey(projectSlug: string, issueNumber: number): string {
    return `${projectSlug}:${issueNumber.toString()}`;
  }

  #enqueueFailure(operationName: string, failure: MockOperationFailure): void {
    const queue = this.#failures.get(operationName) ?? [];
    queue.push(failure);
    this.#failures.set(operationName, queue);
  }

  #shiftFailure(operationName: string): MockOperationFailure | null {
    const queue = this.#failures.get(operationName);
    if (queue === undefined || queue.length === 0) {
      return null;
    }
    const next = queue.shift() ?? null;
    if (queue.length === 0) {
      this.#failures.delete(operationName);
    }
    return next;
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected string for ${field}`);
  }
  return value;
}

function requireOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected string or null for ${field}`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected string or null for ${field}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Expected number for ${field}`);
  }
  return value;
}
