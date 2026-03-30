import fs from "node:fs/promises";
import path from "node:path";
import { ObservabilityError } from "../domain/errors.js";
import type { RuntimeInstanceInput } from "../domain/workflow.js";
import { coerceRuntimeInstancePaths } from "../domain/workflow.js";
import type { IssueArtifactOutcome } from "./issue-artifacts.js";
import { writeJsonFileAtomic } from "./atomic-file.js";

export const OPERATOR_RELEASE_STATE_SCHEMA_VERSION = 1 as const;

export type OperatorReleaseAdvancementState =
  | "unconfigured"
  | "configured-clear"
  | "blocked-by-prerequisite-failure"
  | "blocked-review-needed";

export interface OperatorReleaseIssueReference {
  readonly issueNumber: number;
  readonly issueIdentifier: string | null;
  readonly title: string | null;
}

export interface OperatorReleaseDependency {
  readonly prerequisite: OperatorReleaseIssueReference;
  readonly downstream: readonly OperatorReleaseIssueReference[];
}

export interface OperatorReleaseConfiguration {
  readonly releaseId: string | null;
  readonly dependencies: readonly OperatorReleaseDependency[];
}

export interface OperatorReleaseEvaluation {
  readonly advancementState: OperatorReleaseAdvancementState;
  readonly summary: string;
  readonly evaluatedAt: string;
  readonly blockingPrerequisite: OperatorReleaseIssueReference | null;
  readonly blockedDownstream: readonly OperatorReleaseIssueReference[];
  readonly unresolvedReferences: readonly OperatorReleaseIssueReference[];
}

export type OperatorReadyPromotionState =
  | "unconfigured"
  | "blocked-review-needed"
  | "labels-synchronized"
  | "sync-failed";

export interface OperatorReadyPromotionResult {
  readonly state: OperatorReadyPromotionState;
  readonly summary: string;
  readonly promotedAt: string;
  readonly eligibleIssues: readonly OperatorReleaseIssueReference[];
  readonly readyLabelsAdded: readonly OperatorReleaseIssueReference[];
  readonly readyLabelsRemoved: readonly OperatorReleaseIssueReference[];
  readonly error: string | null;
}

export interface OperatorReleaseStateDocument {
  readonly version: typeof OPERATOR_RELEASE_STATE_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly configuration: OperatorReleaseConfiguration;
  readonly evaluation: OperatorReleaseEvaluation;
  readonly promotion: OperatorReadyPromotionResult;
}

export interface StoredIssueSummary {
  readonly issueNumber: number;
  readonly issueIdentifier: string;
  readonly title: string;
  readonly currentOutcome: IssueArtifactOutcome;
}

export function createEmptyOperatorReleaseState(
  updatedAt = new Date().toISOString(),
): OperatorReleaseStateDocument {
  return {
    version: OPERATOR_RELEASE_STATE_SCHEMA_VERSION,
    updatedAt,
    configuration: {
      releaseId: null,
      dependencies: [],
    },
    evaluation: {
      advancementState: "unconfigured",
      summary:
        "No release dependency metadata is configured for this operator instance.",
      evaluatedAt: updatedAt,
      blockingPrerequisite: null,
      blockedDownstream: [],
      unresolvedReferences: [],
    },
    promotion: createEmptyOperatorReadyPromotionResult(updatedAt),
  };
}

export function createEmptyOperatorReadyPromotionResult(
  promotedAt = new Date().toISOString(),
): OperatorReadyPromotionResult {
  return {
    state: "unconfigured",
    summary: "Ready promotion has not run for this operator instance.",
    promotedAt,
    eligibleIssues: [],
    readyLabelsAdded: [],
    readyLabelsRemoved: [],
    error: null,
  };
}

export async function readOperatorReleaseState(
  filePath: string,
): Promise<OperatorReleaseStateDocument> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parseOperatorReleaseStateDocument(parsed, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyOperatorReleaseState();
    }
    throw error;
  }
}

export async function writeOperatorReleaseState(
  filePath: string,
  state: OperatorReleaseStateDocument,
): Promise<void> {
  await writeJsonFileAtomic(filePath, state, {
    tempPrefix: ".operator-release-state",
  });
}

export async function syncOperatorReleaseState(args: {
  readonly instance: RuntimeInstanceInput;
  readonly releaseStateFile: string;
  readonly updatedAt?: string | undefined;
}): Promise<OperatorReleaseStateDocument> {
  const updatedAt = args.updatedAt ?? new Date().toISOString();
  const instance = coerceRuntimeInstancePaths(args.instance);
  const current = await readOperatorReleaseState(args.releaseStateFile);
  const issueSummaries = await listStoredIssueSummaries(instance);
  const evaluation = evaluateOperatorReleaseState({
    configuration: current.configuration,
    issueSummaries,
    evaluatedAt: updatedAt,
  });
  const nextState: OperatorReleaseStateDocument = {
    version: OPERATOR_RELEASE_STATE_SCHEMA_VERSION,
    updatedAt,
    configuration: current.configuration,
    evaluation,
    promotion: current.promotion,
  };
  await writeOperatorReleaseState(args.releaseStateFile, nextState);
  return nextState;
}

export function evaluateOperatorReleaseState(args: {
  readonly configuration: OperatorReleaseConfiguration;
  readonly issueSummaries: readonly {
    readonly issueNumber: number;
    readonly issueIdentifier: string;
    readonly title: string;
    readonly currentOutcome: string;
  }[];
  readonly evaluatedAt: string;
}): OperatorReleaseEvaluation {
  const releaseLabel = formatReleaseLabel(args.configuration.releaseId);
  const dependencies = args.configuration.dependencies;
  if (dependencies.length === 0) {
    return {
      advancementState: "unconfigured",
      summary:
        "No release dependency metadata is configured for this operator instance.",
      evaluatedAt: args.evaluatedAt,
      blockingPrerequisite: null,
      blockedDownstream: [],
      unresolvedReferences: [],
    };
  }

  const issuesByNumber = new Map(
    args.issueSummaries.map((issue) => [issue.issueNumber, issue]),
  );

  for (const dependency of dependencies) {
    const prerequisite = issuesByNumber.get(
      dependency.prerequisite.issueNumber,
    );
    if (prerequisite?.currentOutcome === "failed") {
      return {
        advancementState: "blocked-by-prerequisite-failure",
        summary: `${releaseLabel} is blocked: prerequisite issue #${dependency.prerequisite.issueNumber.toString()} failed. Do not advance downstream work until the prerequisite is repaired.`,
        evaluatedAt: args.evaluatedAt,
        blockingPrerequisite: dependency.prerequisite,
        blockedDownstream: dependency.downstream,
        unresolvedReferences: [],
      };
    }
  }

  const unresolvedReferences: OperatorReleaseIssueReference[] = [];
  for (const dependency of dependencies) {
    if (dependency.downstream.length === 0) {
      unresolvedReferences.push(dependency.prerequisite);
      continue;
    }
    if (!issuesByNumber.has(dependency.prerequisite.issueNumber)) {
      unresolvedReferences.push(dependency.prerequisite);
    }
    for (const downstream of dependency.downstream) {
      if (!issuesByNumber.has(downstream.issueNumber)) {
        unresolvedReferences.push(downstream);
      }
    }
  }

  const dedupedUnresolved = dedupeIssueReferences(unresolvedReferences);
  if (dedupedUnresolved.length > 0) {
    return {
      advancementState: "blocked-review-needed",
      summary: `${releaseLabel} needs review before downstream advancement: dependency metadata is incomplete or references issue facts that are not currently available.`,
      evaluatedAt: args.evaluatedAt,
      blockingPrerequisite: null,
      blockedDownstream: [],
      unresolvedReferences: dedupedUnresolved,
    };
  }

  return {
    advancementState: "configured-clear",
    summary: `${releaseLabel} is clear for downstream advancement: no configured prerequisite issue is currently failed.`,
    evaluatedAt: args.evaluatedAt,
    blockingPrerequisite: null,
    blockedDownstream: [],
    unresolvedReferences: [],
  };
}

function parseOperatorReleaseStateDocument(
  value: unknown,
  filePath: string,
): OperatorReleaseStateDocument {
  if (!isRecord(value)) {
    throw new ObservabilityError(
      `Malformed operator release state in ${filePath}; expected an object.`,
    );
  }

  if (value.version !== OPERATOR_RELEASE_STATE_SCHEMA_VERSION) {
    throw new ObservabilityError(
      `Unsupported operator release state schema in ${filePath}`,
    );
  }

  if (typeof value.updatedAt !== "string") {
    throw new ObservabilityError(
      `Malformed operator release state in ${filePath}; expected updatedAt.`,
    );
  }

  return {
    version: OPERATOR_RELEASE_STATE_SCHEMA_VERSION,
    updatedAt: value.updatedAt,
    configuration: parseOperatorReleaseConfiguration(
      value.configuration,
      filePath,
    ),
    evaluation: parseOperatorReleaseEvaluation(value.evaluation, filePath),
    promotion: parseOperatorReadyPromotionResult(value.promotion, filePath),
  };
}

function parseOperatorReleaseConfiguration(
  value: unknown,
  filePath: string,
): OperatorReleaseConfiguration {
  if (!isRecord(value) || !Array.isArray(value.dependencies)) {
    throw new ObservabilityError(
      `Malformed operator release state in ${filePath}; expected configuration.dependencies.`,
    );
  }
  return {
    releaseId:
      value.releaseId === null || value.releaseId === undefined
        ? null
        : requireString(value.releaseId, `${filePath} configuration.releaseId`),
    dependencies: value.dependencies.map((dependency, index) =>
      parseOperatorReleaseDependency(
        dependency,
        `${filePath} configuration.dependencies[${index.toString()}]`,
      ),
    ),
  };
}

function parseOperatorReleaseDependency(
  value: unknown,
  field: string,
): OperatorReleaseDependency {
  if (!isRecord(value) || !Array.isArray(value.downstream)) {
    throw new ObservabilityError(
      `Malformed operator release state in ${field}; expected prerequisite and downstream references.`,
    );
  }
  return {
    prerequisite: parseOperatorReleaseIssueReference(
      value.prerequisite,
      `${field}.prerequisite`,
    ),
    downstream: value.downstream.map((reference, index) =>
      parseOperatorReleaseIssueReference(
        reference,
        `${field}.downstream[${index.toString()}]`,
      ),
    ),
  };
}

function parseOperatorReleaseEvaluation(
  value: unknown,
  filePath: string,
): OperatorReleaseEvaluation {
  if (!isRecord(value)) {
    throw new ObservabilityError(
      `Malformed operator release state in ${filePath}; expected evaluation.`,
    );
  }
  if (
    value.advancementState !== "unconfigured" &&
    value.advancementState !== "configured-clear" &&
    value.advancementState !== "blocked-by-prerequisite-failure" &&
    value.advancementState !== "blocked-review-needed"
  ) {
    throw new ObservabilityError(
      `Malformed operator release state in ${filePath}; expected a supported advancementState.`,
    );
  }
  if (
    typeof value.summary !== "string" ||
    typeof value.evaluatedAt !== "string" ||
    !Array.isArray(value.blockedDownstream) ||
    !Array.isArray(value.unresolvedReferences)
  ) {
    throw new ObservabilityError(
      `Malformed operator release state in ${filePath}; expected evaluation fields.`,
    );
  }
  return {
    advancementState: value.advancementState,
    summary: value.summary,
    evaluatedAt: value.evaluatedAt,
    blockingPrerequisite:
      value.blockingPrerequisite === null ||
      value.blockingPrerequisite === undefined
        ? null
        : parseOperatorReleaseIssueReference(
            value.blockingPrerequisite,
            `${filePath} evaluation.blockingPrerequisite`,
          ),
    blockedDownstream: value.blockedDownstream.map((reference, index) =>
      parseOperatorReleaseIssueReference(
        reference,
        `${filePath} evaluation.blockedDownstream[${index.toString()}]`,
      ),
    ),
    unresolvedReferences: value.unresolvedReferences.map((reference, index) =>
      parseOperatorReleaseIssueReference(
        reference,
        `${filePath} evaluation.unresolvedReferences[${index.toString()}]`,
      ),
    ),
  };
}

function parseOperatorReadyPromotionResult(
  value: unknown,
  filePath: string,
): OperatorReadyPromotionResult {
  if (value === undefined) {
    return createEmptyOperatorReadyPromotionResult();
  }
  if (!isRecord(value)) {
    throw new ObservabilityError(
      `Malformed operator release state in ${filePath}; expected promotion.`,
    );
  }
  if (
    value.state !== "unconfigured" &&
    value.state !== "blocked-review-needed" &&
    value.state !== "labels-synchronized" &&
    value.state !== "sync-failed"
  ) {
    throw new ObservabilityError(
      `Malformed operator release state in ${filePath}; expected a supported promotion.state.`,
    );
  }
  if (
    typeof value.summary !== "string" ||
    typeof value.promotedAt !== "string" ||
    !Array.isArray(value.eligibleIssues) ||
    !Array.isArray(value.readyLabelsAdded) ||
    !Array.isArray(value.readyLabelsRemoved)
  ) {
    throw new ObservabilityError(
      `Malformed operator release state in ${filePath}; expected promotion fields.`,
    );
  }

  return {
    state: value.state,
    summary: value.summary,
    promotedAt: value.promotedAt,
    eligibleIssues: value.eligibleIssues.map((reference, index) =>
      parseOperatorReleaseIssueReference(
        reference,
        `${filePath} promotion.eligibleIssues[${index.toString()}]`,
      ),
    ),
    readyLabelsAdded: value.readyLabelsAdded.map((reference, index) =>
      parseOperatorReleaseIssueReference(
        reference,
        `${filePath} promotion.readyLabelsAdded[${index.toString()}]`,
      ),
    ),
    readyLabelsRemoved: value.readyLabelsRemoved.map((reference, index) =>
      parseOperatorReleaseIssueReference(
        reference,
        `${filePath} promotion.readyLabelsRemoved[${index.toString()}]`,
      ),
    ),
    error:
      value.error === null || value.error === undefined
        ? null
        : requireString(value.error, `${filePath} promotion.error`),
  };
}

function parseOperatorReleaseIssueReference(
  value: unknown,
  field: string,
): OperatorReleaseIssueReference {
  if (!isRecord(value)) {
    throw new ObservabilityError(
      `Malformed operator release state in ${field}; expected an issue reference.`,
    );
  }

  const issueNumber = value.issueNumber;
  if (
    typeof issueNumber !== "number" ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    throw new ObservabilityError(
      `Malformed operator release state in ${field}; expected a positive integer issueNumber.`,
    );
  }

  return {
    issueNumber,
    issueIdentifier: normalizeNullableString(value.issueIdentifier, field),
    title: normalizeNullableString(value.title, field),
  };
}

export async function listStoredIssueSummaries(
  instance: ReturnType<typeof coerceRuntimeInstancePaths>,
): Promise<readonly StoredIssueSummary[]> {
  const entries = await fs
    .readdir(instance.issueArtifactsRoot, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });

  const issues = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .map(async (entry) => {
        const issueFile = path.join(
          instance.issueArtifactsRoot,
          entry.name,
          "issue.json",
        );
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(await fs.readFile(issueFile, "utf8")) as Record<
            string,
            unknown
          >;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw error;
        }

        const issueNumber = parsed["issueNumber"];
        const issueIdentifier = parsed["issueIdentifier"];
        const title = parsed["title"];
        const currentOutcome = parsed["currentOutcome"];
        if (
          typeof issueNumber !== "number" ||
          typeof issueIdentifier !== "string" ||
          typeof title !== "string" ||
          typeof currentOutcome !== "string"
        ) {
          throw new ObservabilityError(
            `Malformed issue summary at ${issueFile}; expected issueNumber, issueIdentifier, title, and currentOutcome.`,
          );
        }
        return {
          issueNumber,
          issueIdentifier,
          title,
          currentOutcome: currentOutcome as IssueArtifactOutcome,
        } satisfies StoredIssueSummary;
      }),
  );

  return issues.filter((issue): issue is StoredIssueSummary => issue !== null);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ObservabilityError(
      `Malformed operator release state in ${field}`,
    );
  }
  return value;
}

function normalizeNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ObservabilityError(
      `Malformed operator release state in ${field}`,
    );
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
