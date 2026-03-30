import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { TrackerError } from "../domain/errors.js";

const execFile = promisify(execFileCallback);

export interface CreatedGitHubIssue {
  readonly number: number;
  readonly url: string;
  readonly title: string;
}

export async function createGitHubFollowUpIssue(args: {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): Promise<CreatedGitHubIssue> {
  const { stdout } = await execFile(
    "gh",
    [
      "issue",
      "create",
      "--repo",
      args.repo,
      "--title",
      args.title,
      "--body",
      args.body,
    ],
    {
      cwd: args.cwd,
      env: args.env,
    },
  ).catch((error) => {
    throw new TrackerError(
      `Failed to create GitHub follow-up issue in ${args.repo}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        cause: error as Error,
      },
    );
  });

  const url = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (!url) {
    throw new TrackerError(
      `GitHub follow-up issue creation for ${args.repo} returned no issue URL.`,
    );
  }
  const numberMatch = url.match(/\/issues\/(\d+)(?:$|[#?])/u);
  if (!numberMatch) {
    throw new TrackerError(
      `GitHub follow-up issue creation for ${args.repo} returned an unparseable issue URL: ${url}`,
    );
  }

  return {
    number: Number.parseInt(numberMatch[1] ?? "", 10),
    url,
    title: args.title,
  };
}
