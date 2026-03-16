import type { TrackerConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import type { Tracker } from "./service.js";
import { GitHubTracker } from "./github.js";
import { GitHubBootstrapTracker } from "./github-bootstrap.js";
import { LinearTracker } from "./linear.js";

export function createTracker(config: TrackerConfig, logger: Logger): Tracker {
  switch (config.kind) {
    case "github":
      return new GitHubTracker(config, logger);
    case "github-bootstrap":
      return new GitHubBootstrapTracker(config, logger);
    case "linear":
      return new LinearTracker(config, logger);
    default:
      return exhaustiveTrackerConfig(config);
  }
}

function exhaustiveTrackerConfig(config: never): never {
  throw new Error(`Unsupported tracker config '${JSON.stringify(config)}'`);
}
