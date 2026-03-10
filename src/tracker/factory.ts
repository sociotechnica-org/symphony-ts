import type { TrackerConfig } from "../domain/workflow.js";
import { TrackerError } from "../domain/errors.js";
import type { Logger } from "../observability/logger.js";
import type { Tracker } from "./service.js";
import { GitHubBootstrapTracker } from "./github-bootstrap.js";

export function createTracker(config: TrackerConfig, logger: Logger): Tracker {
  switch (config.kind) {
    case "github-bootstrap":
      return new GitHubBootstrapTracker(config, logger);
    case "linear":
      throw new TrackerError(
        "tracker.kind 'linear' is not yet supported by `symphony run`; workflow loading and validation are available, but the Linear tracker adapter has not been implemented yet.",
      );
    default:
      return exhaustiveTrackerConfig(config);
  }
}

function exhaustiveTrackerConfig(config: never): never {
  throw new Error(`Unsupported tracker config '${JSON.stringify(config)}'`);
}
