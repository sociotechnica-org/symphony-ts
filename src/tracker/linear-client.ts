import { TrackerError } from "../domain/errors.js";
import type { LinearTrackerConfig } from "../domain/workflow.js";

interface GraphQLErrorPayload {
  readonly message?: unknown;
}

interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: readonly GraphQLErrorPayload[];
}

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
      issues(first: 2, after: $after, assignee: $assignee) {
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

const ISSUE_UPDATE_MUTATION = `
  mutation UpdateIssue($id: String!, $description: String, $stateId: String) {
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

export class LinearClient {
  readonly #config: LinearTrackerConfig;

  constructor(config: LinearTrackerConfig) {
    this.#config = config;
  }

  async fetchProject(): Promise<unknown> {
    return await this.#request("GetProject", GET_PROJECT_QUERY, {
      slugId: this.#config.projectSlug,
    });
  }

  async fetchProjectIssuesPage(after: string | null): Promise<unknown> {
    return await this.#request(
      "GetProjectIssuesPage",
      GET_PROJECT_ISSUES_PAGE_QUERY,
      {
        slugId: this.#config.projectSlug,
        after,
        assignee: this.#config.assignee,
      },
    );
  }

  async fetchProjectIssue(issueNumber: number): Promise<unknown> {
    return await this.#request("GetProjectIssue", GET_PROJECT_ISSUE_QUERY, {
      slugId: this.#config.projectSlug,
      number: issueNumber,
    });
  }

  async updateIssue(input: {
    readonly id: string;
    readonly description?: string;
    readonly stateId?: string;
  }): Promise<unknown> {
    return await this.#request("UpdateIssue", ISSUE_UPDATE_MUTATION, {
      id: input.id,
      description: input.description ?? null,
      stateId: input.stateId ?? null,
    });
  }

  async createComment(issueId: string, body: string): Promise<unknown> {
    return await this.#request("CreateComment", COMMENT_CREATE_MUTATION, {
      issueId,
      body,
    });
  }

  async #request<T>(
    operationName: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.#config.endpoint, {
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

    const payload = (await response.json()) as GraphQLResponse<T>;
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
}
