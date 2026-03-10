import type { LinearTrackerConfig } from "../domain/workflow.js";
import { TrackerError } from "../domain/errors.js";
import {
  requireArray,
  requireBoolean,
  requireNullableString,
  requireObject,
} from "./linear-parse.js";

export interface LinearRawWorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly position: number;
}

export interface LinearRawCommentUser {
  readonly name: string | null;
  readonly email: string | null;
}

export interface LinearRawComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly user: LinearRawCommentUser | null;
}

export interface LinearRawIssue {
  readonly id: string;
  readonly identifier: string;
  readonly number: number;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: LinearRawWorkflowState;
  readonly comments: {
    readonly nodes: readonly LinearRawComment[];
  };
}

export interface LinearRawProject {
  readonly id: string;
  readonly slugId: string;
  readonly name: string;
  readonly states: {
    readonly nodes: readonly LinearRawWorkflowState[];
  };
}

export interface LinearRawPageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface LinearRawProjectIssuesConnection {
  readonly nodes: readonly LinearRawIssue[];
  readonly pageInfo: LinearRawPageInfo;
}

export interface LinearRawProjectWithIssues extends LinearRawProject {
  readonly issues: LinearRawProjectIssuesConnection;
}

export interface LinearRawProjectWithIssue extends LinearRawProject {
  readonly issue: LinearRawIssue | null;
}

export interface LinearRawIssueMutation {
  readonly success: boolean;
  readonly issue: LinearRawIssue | null;
}

export interface LinearProjectQueryResult {
  readonly project: LinearRawProject | null;
}

export interface LinearProjectIssuesResult {
  readonly project: LinearRawProject;
  readonly issues: readonly LinearRawIssue[];
}

export interface LinearProjectIssueResult {
  readonly project: LinearRawProjectWithIssue | null;
}

export interface LinearIssueUpdateResult {
  readonly issueUpdate: LinearRawIssueMutation;
}

export interface LinearCommentCreateResult {
  readonly commentCreate: LinearRawIssueMutation;
}

interface GraphQLErrorPayload {
  readonly message?: unknown;
}

interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: readonly GraphQLErrorPayload[];
}

interface UpdateIssueRequest {
  readonly id: string;
  readonly description?: string;
  readonly stateId?: string;
}

interface LinearClientOptions {
  readonly fetch?: typeof fetch;
}

const LINEAR_PROJECT_ISSUES_PAGE_SIZE = 50;

const PROJECT_FIELDS = `
  id
  slugId
  name
  states {
    nodes {
      id
      name
      type
      position
    }
  }
`;

const ISSUE_FIELDS = `
  id
  identifier
  number
  title
  description
  url
  createdAt
  updatedAt
  state {
    id
    name
    type
    position
  }
  comments {
    nodes {
      id
      body
      createdAt
      user {
        name
        email
      }
    }
  }
`;

const GET_PROJECT_QUERY = `
  query GetProject($slugId: String!) {
    project(slugId: $slugId) {
      ${PROJECT_FIELDS}
    }
  }
`;

const GET_PROJECT_ISSUES_PAGE_QUERY = `
  query GetProjectIssuesPage($slugId: String!, $after: String, $assignee: String) {
    project(slugId: $slugId) {
      ${PROJECT_FIELDS}
      issues(first: ${LINEAR_PROJECT_ISSUES_PAGE_SIZE}, after: $after, assignee: $assignee) {
        nodes {
          ${ISSUE_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const GET_PROJECT_ISSUE_QUERY = `
  query GetProjectIssue($slugId: String!, $number: Int!) {
    project(slugId: $slugId) {
      ${PROJECT_FIELDS}
      issue(number: $number) {
        ${ISSUE_FIELDS}
      }
    }
  }
`;

const ISSUE_UPDATE_DESCRIPTION_MUTATION = `
  mutation UpdateIssueDescription($id: String!, $description: String) {
    issueUpdate(id: $id, input: { description: $description }) {
      success
      issue {
        ${ISSUE_FIELDS}
      }
    }
  }
`;

const ISSUE_UPDATE_STATE_MUTATION = `
  mutation UpdateIssueState($id: String!, $stateId: String) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue {
        ${ISSUE_FIELDS}
      }
    }
  }
`;

const ISSUE_UPDATE_DESCRIPTION_AND_STATE_MUTATION = `
  mutation UpdateIssueDescriptionAndState($id: String!, $description: String, $stateId: String) {
    issueUpdate(id: $id, input: { description: $description, stateId: $stateId }) {
      success
      issue {
        ${ISSUE_FIELDS}
      }
    }
  }
`;

const COMMENT_CREATE_MUTATION = `
  mutation CreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      issue {
        ${ISSUE_FIELDS}
      }
    }
  }
`;

const GRAPHQL_VALIDATION_PREFIX = "Linear GraphQL request failed";

export class LinearClient {
  readonly #config: LinearTrackerConfig;
  readonly #fetch: typeof fetch;

  constructor(config: LinearTrackerConfig, options: LinearClientOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? fetch;
  }

  async fetchProject(): Promise<LinearProjectQueryResult> {
    return await this.#request("GetProject", GET_PROJECT_QUERY, {
      slugId: this.#config.projectSlug,
    });
  }

  async fetchProjectIssues(): Promise<LinearProjectIssuesResult> {
    const issues: LinearRawIssue[] = [];
    let after: string | null = null;
    let project: LinearRawProject | null = null;

    while (true) {
      const page = this.#requireProjectIssuesPage(
        await this.#fetchProjectIssuesPage(after),
      );

      if (project === null) {
        project = this.#projectFromIssuePage(page);
      }
      issues.push(...page.issues.nodes);

      const pageInfo = page.issues.pageInfo;
      if (!pageInfo.hasNextPage || pageInfo.endCursor === null) {
        break;
      }
      after = pageInfo.endCursor;
    }

    // TypeScript cannot prove the loop above runs at least once.
    // #requireProjectIssuesPage throws before returning if project is null.
    if (project === null) {
      throw new TrackerError(
        "Linear GraphQL request failed for GetProjectIssuesPage: missing project payload",
      );
    }

    return {
      project,
      issues,
    };
  }

  async fetchProjectIssue(
    issueNumber: number,
  ): Promise<LinearProjectIssueResult> {
    return await this.#request("GetProjectIssue", GET_PROJECT_ISSUE_QUERY, {
      slugId: this.#config.projectSlug,
      number: issueNumber,
    });
  }

  async updateIssue(
    input: UpdateIssueRequest,
  ): Promise<LinearIssueUpdateResult> {
    return await this.#request(
      this.#updateIssueOperation(input),
      this.#updateIssueMutation(input),
      this.#updateIssueVariables(input),
    );
  }

  async createComment(
    issueId: string,
    body: string,
  ): Promise<LinearCommentCreateResult> {
    return await this.#request("CreateComment", COMMENT_CREATE_MUTATION, {
      issueId,
      body,
    });
  }

  async #fetchProjectIssuesPage(
    after: string | null,
  ): Promise<unknown> {
    return await this.#request<unknown>(
      "GetProjectIssuesPage",
      GET_PROJECT_ISSUES_PAGE_QUERY,
      {
        slugId: this.#config.projectSlug,
        after,
        assignee: this.#config.assignee,
      },
    );
  }

  async #request<T>(
    operationName: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(this.#config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operationName,
          query,
          variables,
        }),
      });
    } catch (error) {
      throw new TrackerError(
        `Linear GraphQL request failed for ${operationName}: ${(error as Error).message}`,
        { cause: error as Error },
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new TrackerError(
        `Linear GraphQL request failed for ${operationName}: HTTP ${response.status} ${body}`.trim(),
      );
    }

    let payload: GraphQLResponse<T>;
    try {
      payload = (await response.json()) as GraphQLResponse<T>;
    } catch (error) {
      throw new TrackerError(
        `Linear GraphQL request failed for ${operationName}: invalid JSON response`,
        { cause: error as Error },
      );
    }

    if ((payload.errors?.length ?? 0) > 0) {
      const messages = payload.errors
        ?.map((entry) =>
          typeof entry.message === "string"
            ? entry.message
            : "Unknown GraphQL error",
        )
        .join("; ");
      throw new TrackerError(
        `Linear GraphQL request failed for ${operationName}: ${messages}`,
      );
    }
    if (payload.data === undefined) {
      throw new TrackerError(
        `Linear GraphQL request failed for ${operationName}: missing data payload`,
      );
    }
    return payload.data;
  }

  #projectFromIssuePage(project: LinearRawProjectWithIssues): LinearRawProject {
    return {
      id: project.id,
      slugId: project.slugId,
      name: project.name,
      states: project.states,
    };
  }

  #requireProjectIssuesPage(
    page: unknown,
  ): LinearRawProjectWithIssues {
    const root = requireObject(
      page,
      "GetProjectIssuesPage.data",
      GRAPHQL_VALIDATION_PREFIX,
    );
    const project = requireObject(
      root["project"],
      "GetProjectIssuesPage.data.project",
      GRAPHQL_VALIDATION_PREFIX,
    );
    const issues = requireObject(
      project["issues"],
      "GetProjectIssuesPage.data.project.issues",
      GRAPHQL_VALIDATION_PREFIX,
    );
    requireArray(
      issues["nodes"],
      "GetProjectIssuesPage.data.project.issues.nodes",
      GRAPHQL_VALIDATION_PREFIX,
    );
    const pageInfo = requireObject(
      issues["pageInfo"],
      "GetProjectIssuesPage.data.project.issues.pageInfo",
      GRAPHQL_VALIDATION_PREFIX,
    );
    requireBoolean(
      pageInfo["hasNextPage"],
      "GetProjectIssuesPage.data.project.issues.pageInfo.hasNextPage",
      GRAPHQL_VALIDATION_PREFIX,
    );
    requireNullableString(
      pageInfo["endCursor"],
      "GetProjectIssuesPage.data.project.issues.pageInfo.endCursor",
      GRAPHQL_VALIDATION_PREFIX,
    );
    return project as unknown as LinearRawProjectWithIssues;
  }

  #updateIssueOperation(input: UpdateIssueRequest): string {
    const hasDescription = input.description !== undefined;
    const hasStateId = input.stateId !== undefined;
    if (hasDescription && hasStateId) {
      return "UpdateIssueDescriptionAndState";
    }
    if (hasDescription) {
      return "UpdateIssueDescription";
    }
    if (hasStateId) {
      return "UpdateIssueState";
    }
    throw new TrackerError("Linear issue update requires at least one field");
  }

  #updateIssueMutation(input: UpdateIssueRequest): string {
    const hasDescription = input.description !== undefined;
    const hasStateId = input.stateId !== undefined;
    if (hasDescription && hasStateId) {
      return ISSUE_UPDATE_DESCRIPTION_AND_STATE_MUTATION;
    }
    if (hasDescription) {
      return ISSUE_UPDATE_DESCRIPTION_MUTATION;
    }
    if (hasStateId) {
      return ISSUE_UPDATE_STATE_MUTATION;
    }
    throw new TrackerError("Linear issue update requires at least one field");
  }

  #updateIssueVariables(
    input: UpdateIssueRequest,
  ): Readonly<Record<string, unknown>> {
    const variables: Record<string, unknown> = { id: input.id };
    if (input.description !== undefined) {
      variables["description"] = input.description;
    }
    if (input.stateId !== undefined) {
      variables["stateId"] = input.stateId;
    }
    return variables;
  }
}
