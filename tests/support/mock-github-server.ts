import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

interface PullRequestRecord {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
}

interface MockIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  comments: string[];
}

interface MockLabel {
  name: string;
  color: string;
  description: string;
}

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

export class MockGitHubServer {
  readonly #issues = new Map<number, MockIssue>();
  readonly #labels = new Map<string, MockLabel>();
  readonly #prs: PullRequestRecord[] = [];
  readonly #requestCounts = new Map<string, number>();
  readonly #server = http.createServer(this.#handle.bind(this));
  #baseUrl = "";

  async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Mock GitHub server failed to bind");
    }
    this.#baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    this.#server.close();
    await once(this.#server, "close");
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  seedIssue(input: {
    number: number;
    title: string;
    body: string;
    labels: readonly string[];
    state?: string;
  }): void {
    const now = new Date().toISOString();
    this.#issues.set(input.number, {
      id: randomUUID(),
      number: input.number,
      title: input.title,
      body: input.body,
      state: input.state ?? "open",
      html_url: `${this.#baseUrl}/issues/${input.number}`,
      created_at: now,
      updated_at: now,
      labels: input.labels.map((name) => ({ name })),
      comments: [],
    });
  }

  getIssue(number: number): MockIssue {
    const issue = this.#issues.get(number);
    if (!issue) {
      throw new Error(`Issue ${number} not found`);
    }
    return structuredClone(issue);
  }

  getPullRequests(): readonly PullRequestRecord[] {
    return structuredClone(this.#prs);
  }

  countRequests(key: string): number {
    return this.#requestCounts.get(key) ?? 0;
  }

  async recordPullRequest(pr: PullRequestRecord): Promise<void> {
    this.#prs.push(pr);
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", this.#baseUrl);
    const method = request.method ?? "GET";

    if (method === "POST" && url.pathname === "/mock/prs") {
      const body = (await readJson(request)) as PullRequestRecord;
      this.#prs.push(body);
      json(response, 201, { ok: true });
      return;
    }

    const pathMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!pathMatch) {
      json(response, 404, { message: "not found" });
      return;
    }

    const suffix = pathMatch[3] ?? "";
    const requestKey = `${method} ${suffix}`;
    this.#requestCounts.set(
      requestKey,
      (this.#requestCounts.get(requestKey) ?? 0) + 1,
    );

    if (method === "GET" && suffix === "labels") {
      json(response, 200, [...this.#labels.values()]);
      return;
    }

    if (method === "POST" && suffix === "labels") {
      const body = (await readJson(request)) as {
        name: string;
        color: string;
        description: string;
      };
      const label = {
        name: body.name,
        color: body.color,
        description: body.description,
      };
      this.#labels.set(label.name, label);
      json(response, 201, label);
      return;
    }

    const labelMatch = suffix.match(/^labels\/(.+)$/);
    if (method === "GET" && labelMatch) {
      const labelName = decodeURIComponent(labelMatch[1] ?? "");
      const label = this.#labels.get(labelName);
      if (!label) {
        json(response, 404, { message: "label not found" });
        return;
      }
      json(response, 200, label);
      return;
    }

    if (method === "GET" && suffix === "issues") {
      const state = url.searchParams.get("state") ?? "open";
      const label = url.searchParams.get("labels");
      const issues = [...this.#issues.values()]
        .filter((issue) => issue.state === state)
        .filter((issue) => {
          if (!label) {
            return true;
          }
          return issue.labels.some((entry) => entry.name === label);
        });
      json(response, 200, issues);
      return;
    }

    if (method === "GET" && suffix === "pulls") {
      const head = url.searchParams.get("head");
      const state = url.searchParams.get("state") ?? "open";
      const pulls = this.#prs
        // The mock does not model PR lifecycle; stored PRs are treated as open.
        .filter(() => state === "open" || state === "all")
        .filter((pull) =>
          head ? `${pathMatch[1]}:${pull.head}` === head : true,
        )
        .map((pull, index) => ({
          id: index + 1,
          html_url: `${this.#baseUrl}/pulls/${index + 1}`,
          state: "open",
          head: {
            ref: pull.head,
          },
        }));
      json(response, 200, pulls);
      return;
    }

    const issueMatch = suffix.match(/^issues\/(\d+)$/);
    if (issueMatch) {
      const issueNumber = Number(issueMatch[1]);
      const issue = this.#issues.get(issueNumber);
      if (!issue) {
        json(response, 404, { message: "issue not found" });
        return;
      }
      if (method === "GET") {
        json(response, 200, issue);
        return;
      }
      if (method === "PATCH") {
        const body = (await readJson(request)) as {
          labels?: string[];
          state?: string;
        };
        if (body.labels) {
          issue.labels = body.labels.map((name) => ({ name }));
        }
        if (body.state) {
          issue.state = body.state;
        }
        issue.updated_at = new Date().toISOString();
        json(response, 200, issue);
        return;
      }
    }

    const commentMatch = suffix.match(/^issues\/(\d+)\/comments$/);
    if (commentMatch && method === "POST") {
      const issueNumber = Number(commentMatch[1]);
      const issue = this.#issues.get(issueNumber);
      if (!issue) {
        json(response, 404, { message: "issue not found" });
        return;
      }
      const body = (await readJson(request)) as { body: string };
      issue.comments.push(body.body);
      issue.updated_at = new Date().toISOString();
      json(response, 201, { id: randomUUID(), body: body.body });
      return;
    }

    json(response, 404, { message: "not found" });
  }
}
