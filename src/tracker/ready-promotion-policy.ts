import type { IssueArtifactOutcome } from "../observability/issue-artifacts.js";
import type {
  OperatorReleaseConfiguration,
  OperatorReleaseIssueReference,
} from "../observability/operator-release-state.js";

export interface ReadyPromotionIssueFact {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly currentOutcome: IssueArtifactOutcome;
}

export interface ReadyPromotionTrackerIssue {
  readonly issueNumber: number;
  readonly issueIdentifier: string | null;
  readonly title: string | null;
  readonly state: string;
  readonly hasReadyLabel: boolean;
}

export interface ReadyPromotionDecision {
  readonly state:
    | "unconfigured"
    | "blocked-review-needed"
    | "eligible-set-computed";
  readonly summary: string;
  readonly unresolvedReferences: readonly OperatorReleaseIssueReference[];
  readonly eligibleIssues: readonly OperatorReleaseIssueReference[];
  readonly addReadyLabelTo: readonly OperatorReleaseIssueReference[];
  readonly removeReadyLabelFrom: readonly OperatorReleaseIssueReference[];
}

export function evaluateReadyPromotion(args: {
  readonly configuration: OperatorReleaseConfiguration;
  readonly issueFacts: readonly ReadyPromotionIssueFact[];
  readonly trackerIssues: readonly ReadyPromotionTrackerIssue[];
}): ReadyPromotionDecision {
  const releaseLabel = formatReleaseLabel(args.configuration.releaseId);
  const dependencies = args.configuration.dependencies;
  if (dependencies.length === 0) {
    return {
      state: "unconfigured",
      summary:
        "No release dependency metadata is configured for this operator instance.",
      unresolvedReferences: [],
      eligibleIssues: [],
      addReadyLabelTo: [],
      removeReadyLabelFrom: [],
    };
  }

  const issueFactsByNumber = new Map(
    args.issueFacts.map((issue) => [issue.issueNumber, issue]),
  );
  const trackerIssuesByNumber = new Map(
    args.trackerIssues.map((issue) => [issue.issueNumber, issue]),
  );
  const prerequisitesByDownstream = new Map<
    number,
    OperatorReleaseIssueReference[]
  >();
  const downstreamReferences = new Map<number, OperatorReleaseIssueReference>();
  const unresolved: OperatorReleaseIssueReference[] = [];

  for (const dependency of dependencies) {
    if (dependency.downstream.length === 0) {
      unresolved.push(dependency.prerequisite);
      continue;
    }
    if (!issueFactsByNumber.has(dependency.prerequisite.issueNumber)) {
      unresolved.push(dependency.prerequisite);
    }
    for (const downstream of dependency.downstream) {
      downstreamReferences.set(downstream.issueNumber, downstream);
      const prerequisites =
        prerequisitesByDownstream.get(downstream.issueNumber) ?? [];
      prerequisites.push(dependency.prerequisite);
      prerequisitesByDownstream.set(downstream.issueNumber, prerequisites);
      if (!trackerIssuesByNumber.has(downstream.issueNumber)) {
        unresolved.push(downstream);
      }
    }
  }

  const unresolvedReferences = dedupeIssueReferences(unresolved);
  if (unresolvedReferences.length > 0) {
    return {
      state: "blocked-review-needed",
      summary: `${releaseLabel} ready promotion needs review before label synchronization: dependency metadata is incomplete or required issue facts are unavailable.`,
      unresolvedReferences,
      eligibleIssues: [],
      addReadyLabelTo: [],
      removeReadyLabelFrom: [],
    };
  }

  const eligibleIssues: OperatorReleaseIssueReference[] = [];
  const addReadyLabelTo: OperatorReleaseIssueReference[] = [];
  const removeReadyLabelFrom: OperatorReleaseIssueReference[] = [];

  for (const [issueNumber, reference] of downstreamReferences) {
    const trackerIssue = trackerIssuesByNumber.get(issueNumber);
    if (trackerIssue === undefined) {
      continue;
    }
    const issueFact = issueFactsByNumber.get(issueNumber) ?? null;
    const prerequisites = prerequisitesByDownstream.get(issueNumber) ?? [];
    const allPrerequisitesSucceeded = prerequisites.every(
      (prerequisite) =>
        issueFactsByNumber.get(prerequisite.issueNumber)?.currentOutcome ===
        "succeeded",
    );
    const eligible =
      trackerIssue.state === "open" &&
      issueFact === null &&
      allPrerequisitesSucceeded;

    if (eligible) {
      eligibleIssues.push(reference);
      if (!trackerIssue.hasReadyLabel) {
        addReadyLabelTo.push(reference);
      }
      continue;
    }

    if (trackerIssue.hasReadyLabel) {
      removeReadyLabelFrom.push(reference);
    }
  }

  return {
    state: "eligible-set-computed",
    summary: `${releaseLabel} ready promotion computed ${eligibleIssues.length.toString()} eligible downstream issue(s).`,
    unresolvedReferences: [],
    eligibleIssues,
    addReadyLabelTo,
    removeReadyLabelFrom,
  };
}

function dedupeIssueReferences(
  references: readonly OperatorReleaseIssueReference[],
): readonly OperatorReleaseIssueReference[] {
  const seen = new Set<number>();
  const deduped: OperatorReleaseIssueReference[] = [];
  for (const reference of references) {
    if (seen.has(reference.issueNumber)) {
      continue;
    }
    seen.add(reference.issueNumber);
    deduped.push(reference);
  }
  return deduped;
}

function formatReleaseLabel(releaseId: string | null): string {
  return releaseId === null ? "Configured release" : `Release ${releaseId}`;
}
