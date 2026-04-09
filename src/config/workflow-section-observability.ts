import path from "node:path";
import type { ObservabilityConfig } from "../domain/workflow.js";
import {
  coerceOptionalObject,
  requireNumber,
  requireString,
} from "./workflow-validation.js";

export function resolveObservabilityConfig(
  raw: Readonly<Record<string, unknown>>,
  instanceRoot: string,
): ObservabilityConfig {
  const dashboardEnabled = raw["dashboard_enabled"];
  const refreshMs = raw["refresh_ms"];
  const renderIntervalMs = raw["render_interval_ms"];
  const issueReports = raw["issue_reports"];
  const resolvedIssueReports =
    issueReports === undefined
      ? { archiveRoot: null }
      : resolveIssueReportsConfig(issueReports, instanceRoot);
  return {
    dashboardEnabled:
      dashboardEnabled === undefined
        ? true
        : dashboardEnabled === false || dashboardEnabled === "false"
          ? false
          : Boolean(dashboardEnabled),
    refreshMs:
      refreshMs === undefined
        ? 1000
        : requireNumber(refreshMs, "observability.refresh_ms"),
    renderIntervalMs:
      renderIntervalMs === undefined
        ? 16
        : requireNumber(renderIntervalMs, "observability.render_interval_ms"),
    issueReports: resolvedIssueReports,
  };
}

function resolveIssueReportsConfig(
  raw: unknown,
  instanceRoot: string,
): ObservabilityConfig["issueReports"] {
  const issueReports = coerceOptionalObject(raw, "observability.issue_reports");
  const archiveRootRaw = issueReports["archive_root"];
  const archiveRoot =
    archiveRootRaw === undefined
      ? null
      : path.resolve(
          instanceRoot,
          requireString(
            archiveRootRaw,
            "observability.issue_reports.archive_root",
          ),
        );
  return {
    archiveRoot,
  };
}
