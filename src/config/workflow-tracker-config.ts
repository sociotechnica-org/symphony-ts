import { ConfigError } from "../domain/errors.js";
import type {
  GitHubCompatibleTrackerConfig,
  TrackerConfig,
} from "../domain/workflow.js";
import { resolveGitHubTrackerConfig } from "./workflow-tracker-github.js";
import { resolveLinearTrackerConfig } from "./workflow-tracker-linear.js";

const SUPPORTED_TRACKER_KINDS = [
  "github",
  "github-bootstrap",
  "linear",
] as const;

type SupportedTrackerKind = (typeof SUPPORTED_TRACKER_KINDS)[number];

export function resolveTrackerConfig(
  tracker: Readonly<Record<string, unknown>>,
): TrackerConfig {
  const kind = resolveTrackerKind(tracker);
  switch (kind) {
    case "github":
      return resolveGitHubTrackerConfig("github", tracker);
    case "github-bootstrap":
      return resolveGitHubTrackerConfig("github-bootstrap", tracker);
    case "linear":
      return resolveLinearTrackerConfig(tracker);
    default:
      return exhaustiveTrackerConfig(kind);
  }
}

export function isGitHubTrackerConfig(
  tracker: TrackerConfig,
): tracker is GitHubCompatibleTrackerConfig {
  return tracker.kind === "github" || tracker.kind === "github-bootstrap";
}

function isSupportedTrackerKind(value: string): value is SupportedTrackerKind {
  return (SUPPORTED_TRACKER_KINDS as readonly string[]).includes(value);
}

function resolveTrackerKind(
  tracker: Readonly<Record<string, unknown>>,
): TrackerConfig["kind"] {
  if (!Object.hasOwn(tracker, "kind")) {
    return "github-bootstrap";
  }

  const value = tracker["kind"];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError("Expected non-empty string for tracker.kind");
  }

  const normalizedKind = value.trim();
  if (isSupportedTrackerKind(normalizedKind)) {
    return normalizedKind;
  }

  throw new ConfigError(
    `Unsupported tracker.kind '${normalizedKind}'. Supported kinds: ${SUPPORTED_TRACKER_KINDS.join(", ")}`,
  );
}

function exhaustiveTrackerConfig(tracker: never): never {
  throw new ConfigError(
    `Unsupported tracker config '${JSON.stringify(tracker)}'`,
  );
}
