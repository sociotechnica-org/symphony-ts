import { renderFactoryRuntimeIdentity } from "./runtime-identity.js";
import type { FactoryStatusSnapshot } from "./factory-status-snapshot.js";
import {
  assessFactoryStatusSnapshot,
  getFactoryDispatchPressure,
  getFactoryHaltSnapshot,
  getFactoryHostDispatch,
  getFactoryReadyQueue,
  getFactoryRecoveryPosture,
  getFactoryRestartRecovery,
  getFactoryStatusPublication,
  getFactoryTerminalIssues,
  type FactoryStatusFreshnessAssessment,
} from "./factory-status-semantics.js";

export function renderFactoryStatusSnapshot(
  snapshot: FactoryStatusSnapshot,
  options?: {
    readonly statusFilePath?: string;
    readonly freshness?: FactoryStatusFreshnessAssessment;
  },
): string {
  const lines: string[] = [];
  const freshness = options?.freshness ?? assessFactoryStatusSnapshot(snapshot);
  const workerAlive = freshness.workerAlive;
  const workerState =
    workerAlive === null ? "unknown" : workerAlive ? "online" : "offline";

  const publication = getFactoryStatusPublication(snapshot);
  const restartRecovery = getFactoryRestartRecovery(snapshot);
  const recoveryPosture = getFactoryRecoveryPosture(snapshot);
  const factoryHalt = getFactoryHaltSnapshot(snapshot);
  const dispatchPressure = getFactoryDispatchPressure(snapshot);
  const readyQueue = getFactoryReadyQueue(snapshot);
  const terminalIssues = getFactoryTerminalIssues(snapshot);
  const hostDispatch = getFactoryHostDispatch(snapshot);

  lines.push(`Factory: ${snapshot.factoryState}`);
  lines.push(`Snapshot freshness: ${freshness.freshness}`);
  lines.push(`Snapshot detail: ${freshness.summary}`);
  lines.push(
    `Worker: ${workerState} pid=${snapshot.worker.pid.toString()} instance=${snapshot.worker.instanceId}`,
  );
  lines.push(`Snapshot state: ${publication.state}`);
  if (publication.detail !== null) {
    lines.push(`Snapshot state detail: ${publication.detail}`);
  }
  lines.push(`Restart recovery: ${restartRecovery.state}`);
  if (restartRecovery.summary !== null) {
    lines.push(`Restart recovery detail: ${restartRecovery.summary}`);
  }
  lines.push(
    `Factory halt: ${
      factoryHalt.state === "clear"
        ? "clear"
        : factoryHalt.state === "halted"
          ? `halted since ${factoryHalt.haltedAt}`
          : "degraded"
    }`,
  );
  if (factoryHalt.reason !== null) {
    lines.push(`Factory halt reason: ${factoryHalt.reason}`);
  }
  if (factoryHalt.actor !== null || factoryHalt.source !== null) {
    lines.push(
      `Factory halt actor: ${factoryHalt.actor ?? "n/a"} source=${factoryHalt.source ?? "n/a"}`,
    );
  }
  if (factoryHalt.detail !== null) {
    lines.push(`Factory halt detail: ${factoryHalt.detail}`);
  }
  lines.push(
    `Dispatch pressure: ${
      dispatchPressure === null
        ? "open"
        : `${dispatchPressure.retryClass} until ${dispatchPressure.resumeAt}`
    }`,
  );
  if (dispatchPressure !== null) {
    lines.push(`Dispatch pressure detail: ${dispatchPressure.reason}`);
  }
  lines.push(
    `Host dispatch: ${
      hostDispatch === null
        ? "not configured"
        : hostDispatch.hosts
            .map(
              (host) =>
                `${host.name}=${
                  host.occupiedByIssueNumber === null
                    ? "free"
                    : `issue-${host.occupiedByIssueNumber.toString()}`
                }`,
            )
            .join(", ")
    }`,
  );
  lines.push(`Recovery posture: ${recoveryPosture.summary.family}`);
  lines.push(`Recovery detail: ${recoveryPosture.summary.summary}`);
  lines.push(
    `Started: ${snapshot.worker.startedAt}  Snapshot: ${snapshot.generatedAt}`,
  );
  lines.push(
    `Counts: ready=${snapshot.counts.ready.toString()} tracker_running=${snapshot.counts.running.toString()} failed=${snapshot.counts.failed.toString()} local=${snapshot.counts.activeLocalRuns.toString()} retries=${snapshot.counts.retries.toString()}`,
  );
  lines.push(
    `Polling: every ${snapshot.worker.pollIntervalMs.toString()}ms, max concurrency ${snapshot.worker.maxConcurrentRuns.toString()}`,
  );
  lines.push(
    `Runtime checkout: ${snapshot.runtimeIdentity?.checkoutPath ?? "unavailable"}`,
  );
  lines.push(
    `Runtime version: ${renderFactoryRuntimeIdentity(snapshot.runtimeIdentity)}`,
  );
  if (options?.statusFilePath) {
    lines.push(`Snapshot file: ${options.statusFilePath}`);
  }

  if (snapshot.lastAction === null) {
    lines.push("Last action: none");
  } else {
    const issueSuffix =
      snapshot.lastAction.issueNumber === null
        ? ""
        : ` issue #${snapshot.lastAction.issueNumber.toString()}`;
    lines.push(
      `Last action: ${snapshot.lastAction.kind}${issueSuffix} at ${snapshot.lastAction.at} - ${snapshot.lastAction.summary}`,
    );
  }

  lines.push("");
  lines.push("Recovery posture entries:");
  if (recoveryPosture.entries.length === 0) {
    lines.push("  none");
  } else {
    for (const entry of recoveryPosture.entries) {
      const issuePrefix =
        entry.issueNumber === null
          ? ""
          : ` #${entry.issueNumber.toString()} ${entry.issueIdentifier ?? ""}`.trimEnd();
      lines.push(`  [${entry.family}]${issuePrefix}`);
      lines.push(`    Summary: ${entry.summary}`);
      lines.push(`    Source: ${entry.source}`);
      if (entry.observedAt !== null) {
        lines.push(`    Observed: ${entry.observedAt}`);
      }
    }
  }

  lines.push("");
  lines.push("Restart recovery issues:");
  if (restartRecovery.issues.length === 0) {
    lines.push("  none");
  } else {
    for (const issue of restartRecovery.issues) {
      lines.push(
        `  #${issue.issueNumber.toString()} ${issue.issueIdentifier} [${issue.decision}]`,
      );
      lines.push(`    Summary: ${issue.summary}`);
      lines.push(`    Branch: ${issue.branchName}`);
      lines.push(
        `    Lease: ${issue.leaseState}  Lifecycle: ${issue.lifecycleKind ?? "n/a"}`,
      );
      if (issue.executionOwner !== null) {
        lines.push(
          `    Execution: transport=${issue.executionOwner.transport.kind} factory=${issue.executionOwner.factory.host}/${issue.executionOwner.factory.instanceId} session=${issue.executionOwner.runSessionId} remote=${issue.executionOwner.transport.remoteSessionId ?? "n/a"} host=${issue.executionOwner.endpoint.workspaceHost ?? "n/a"} workspace=${issue.executionOwner.endpoint.workspaceId ?? "n/a"}`,
        );
      }
      lines.push(
        `    PIDs: owner=${issue.ownerPid?.toString() ?? "n/a"} runner=${issue.runnerPid?.toString() ?? "n/a"}`,
      );
      lines.push(
        `    Liveness: owner=${issue.ownerAlive === null ? "n/a" : issue.ownerAlive ? "alive" : "dead"} runner=${issue.runnerAlive === null ? "n/a" : issue.runnerAlive ? "alive" : "dead"}`,
      );
      lines.push(`    Observed: ${issue.observedAt}`);
    }
  }

  lines.push("");
  lines.push("Active issues:");
  if (snapshot.activeIssues.length === 0) {
    lines.push("  none");
  } else {
    for (const issue of snapshot.activeIssues) {
      lines.push(
        `  #${issue.issueNumber.toString()} ${issue.title} [${issue.status}]`,
      );
      lines.push(`    Summary: ${issue.summary}`);
      lines.push(`    Branch: ${issue.branchName}`);
      lines.push(
        `    Source: ${issue.source} attempt=${issue.runSequence.toString()}`,
      );
      lines.push(
        `    Workspace: ${issue.workspacePath ?? "n/a"}  Session: ${issue.runSessionId ?? "n/a"}`,
      );
      if (issue.executionOwner !== null) {
        lines.push(
          `    Execution: transport=${issue.executionOwner.transport.kind} factory=${issue.executionOwner.factory.host}/${issue.executionOwner.factory.instanceId} remote=${issue.executionOwner.transport.remoteSessionId ?? "n/a"} host=${issue.executionOwner.endpoint.workspaceHost ?? "n/a"} workspace=${issue.executionOwner.endpoint.workspaceId ?? "n/a"}`,
        );
      }
      lines.push(
        `    PIDs: owner=${issue.ownerPid?.toString() ?? "n/a"} runner=${issue.runnerPid?.toString() ?? "n/a"}`,
      );
      lines.push(
        `    Updated: ${issue.updatedAt}${issue.startedAt === null ? "" : `  Started: ${issue.startedAt}`}`,
      );
      if (issue.pullRequest !== null) {
        lines.push(
          `    PR: #${issue.pullRequest.number.toString()} ${issue.pullRequest.url}`,
        );
      } else {
        lines.push("    PR: none");
      }
      lines.push(
        `    Checks: pending=${issue.checks.pendingNames.length.toString()} failing=${issue.checks.failingNames.length.toString()}`,
      );
      if (issue.checks.pendingNames.length > 0) {
        lines.push(
          `    Pending checks: ${issue.checks.pendingNames.join(", ")}`,
        );
      }
      if (issue.checks.failingNames.length > 0) {
        lines.push(
          `    Failing checks: ${issue.checks.failingNames.join(", ")}`,
        );
      }
      lines.push(
        `    Review: actionable=${issue.review.actionableCount.toString()} unresolved_threads=${issue.review.unresolvedThreadCount.toString()}`,
      );
      if (issue.runnerAccounting !== undefined) {
        lines.push(
          `    Accounting: ${issue.runnerAccounting.status} total_tokens=${renderNullableNumber(issue.runnerAccounting.totalTokens)} cost_usd=${renderNullableNumber(issue.runnerAccounting.costUsd)}`,
        );
      }
      if (issue.blockedReason !== null) {
        lines.push(`    Blocked: ${issue.blockedReason}`);
      }
      if (issue.runnerVisibility !== null) {
        const visibility = issue.runnerVisibility;
        lines.push(
          `    Runner: ${visibility.state} phase=${visibility.phase} provider=${visibility.session.provider}`,
        );
        if (visibility.session.model !== null) {
          lines.push(`    Runner model: ${visibility.session.model}`);
        }
        if (visibility.lastActionSummary !== null) {
          lines.push(
            `    Runner action: ${visibility.lastActionSummary}${
              visibility.lastActionAt === null
                ? ""
                : ` at ${visibility.lastActionAt}`
            }`,
          );
        }
        if (visibility.waitingReason !== null) {
          lines.push(`    Runner waiting: ${visibility.waitingReason}`);
        }
        if (visibility.lastHeartbeatAt !== null) {
          lines.push(`    Runner heartbeat: ${visibility.lastHeartbeatAt}`);
        }
        if (visibility.stdoutSummary !== null) {
          lines.push(`    Runner stdout: ${visibility.stdoutSummary}`);
        }
        if (visibility.stderrSummary !== null) {
          lines.push(`    Runner stderr: ${visibility.stderrSummary}`);
        }
        if (visibility.errorSummary !== null) {
          lines.push(`    Runner error: ${visibility.errorSummary}`);
        }
        if (visibility.cancelledAt !== null) {
          lines.push(`    Runner cancelled: ${visibility.cancelledAt}`);
        }
        if (visibility.timedOutAt !== null) {
          lines.push(`    Runner timed out: ${visibility.timedOutAt}`);
        }
      }
    }
  }

  lines.push("");
  lines.push("Terminal issues:");
  if (terminalIssues.length === 0) {
    lines.push("  none");
  } else {
    for (const issue of terminalIssues) {
      lines.push(
        `  #${issue.issueNumber.toString()} ${issue.title} [${issue.terminalOutcome}]`,
      );
      lines.push(`    Summary: ${issue.summary}`);
      lines.push(`    Branch: ${issue.branchName}`);
      lines.push(`    Observed: ${issue.observedAt}`);
      lines.push(`    Workspace retention: ${issue.workspaceRetentionState}`);
      lines.push(
        `    Reporting: ${issue.reportingState ?? "unavailable"}${
          issue.reportingSummary === null ? "" : ` - ${issue.reportingSummary}`
        }`,
      );
      if (issue.reportingReceiptFile !== null) {
        lines.push(`    Reporting receipt: ${issue.reportingReceiptFile}`);
      }
      if (issue.reportJsonFile !== null) {
        lines.push(`    report.json: ${issue.reportJsonFile}`);
      }
      if (issue.reportMarkdownFile !== null) {
        lines.push(`    report.md: ${issue.reportMarkdownFile}`);
      }
      if (issue.publicationRoot !== null) {
        lines.push(`    Published at: ${issue.publicationRoot}`);
      }
      if (issue.blockedStage !== null) {
        lines.push(`    Blocked stage: ${issue.blockedStage}`);
      }
    }
  }

  lines.push("");
  lines.push("Ready queue:");
  if (readyQueue.length === 0) {
    lines.push("  none");
  } else {
    for (const [index, issue] of readyQueue.entries()) {
      lines.push(
        `  ${String(index + 1)}. #${issue.issueNumber.toString()} ${issue.title}`,
      );
      lines.push(
        `    Priority: ${
          issue.queuePriorityRank === null
            ? "none"
            : `rank=${issue.queuePriorityRank.toString()}${
                issue.queuePriorityLabel === null
                  ? ""
                  : ` label=${issue.queuePriorityLabel}`
              }`
        }`,
      );
      lines.push(
        `    Order reason: ${
          issue.queuePriorityRank === null
            ? "issue-number fallback"
            : "normalized queue priority"
        }`,
      );
    }
  }

  lines.push("");
  lines.push("Host dispatch:");
  if (hostDispatch === null || hostDispatch.hosts.length === 0) {
    lines.push("  none");
  } else {
    for (const host of hostDispatch.hosts) {
      lines.push(
        `  ${host.name} occupied_by=${host.occupiedByIssueNumber?.toString() ?? "none"}`,
      );
      lines.push(
        `    Preferred retries: ${
          host.preferredIssueNumbers.length === 0
            ? "none"
            : host.preferredIssueNumbers
                .map((issueNumber) => `#${issueNumber.toString()}`)
                .join(", ")
        }`,
      );
    }
  }

  lines.push("");
  lines.push("Retries:");
  if (snapshot.retries.length === 0) {
    lines.push("  none");
  } else {
    for (const retry of snapshot.retries) {
      lines.push(
        `  #${retry.issueNumber.toString()} ${retry.title} attempt ${retry.nextAttempt.toString()} [${retry.retryClass}] at ${retry.dueAt}`,
      );
      lines.push(
        `    Scheduled: ${retry.scheduledAt} (+${retry.backoffMs.toString()}ms)`,
      );
      lines.push(`    Preferred host: ${retry.preferredHost ?? "none"}`);
      lines.push(`    Error: ${retry.lastError}`);
    }
  }

  return lines.join("\n");
}

function renderNullableNumber(value: number | null): string {
  return value === null ? "n/a" : value.toString();
}
