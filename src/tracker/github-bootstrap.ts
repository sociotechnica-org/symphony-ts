import type { GitHubBootstrapTrackerConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import { GitHubTracker } from "./github.js";

export class GitHubBootstrapTracker extends GitHubTracker {
  constructor(config: GitHubBootstrapTrackerConfig, logger: Logger) {
    super(config, logger);
  }
}
