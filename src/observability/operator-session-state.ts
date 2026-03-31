import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { ObservabilityError } from "../domain/errors.js";
import type { OperatorProvider } from "../config/operator-loop.js";
import { writeJsonFileAtomic } from "./atomic-file.js";

export const OPERATOR_SESSION_STATE_SCHEMA_VERSION = 1 as const;

export interface OperatorSessionStateDocument {
  readonly version: typeof OPERATOR_SESSION_STATE_SCHEMA_VERSION;
  readonly provider: OperatorProvider;
  readonly model: string | null;
  readonly baseCommandFingerprint: string;
  readonly backendSessionId: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly lastMode: "fresh" | "resuming";
  readonly lastSummary: string;
}

export async function readOperatorSessionState(
  filePath: string,
): Promise<OperatorSessionStateDocument | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseOperatorSessionStateDocument(JSON.parse(raw), filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeOperatorSessionState(
  filePath: string,
  state: OperatorSessionStateDocument,
): Promise<void> {
  await writeJsonFileAtomic(filePath, state, {
    tempPrefix: ".operator-session-state",
  });
}

export async function clearOperatorSessionState(
  filePath: string,
): Promise<void> {
  await fs.rm(filePath, { force: true });
}

export function fingerprintOperatorCommand(args: {
  readonly provider: OperatorProvider;
  readonly baseCommand: string;
}): string {
  return createHash("sha256")
    .update(args.provider)
    .update("\u0000")
    .update(args.baseCommand)
    .digest("hex");
}

export function describeOperatorSessionCompatibility(args: {
  readonly stored: OperatorSessionStateDocument;
  readonly provider: OperatorProvider;
  readonly model: string | null;
  readonly baseCommand: string;
}): {
  readonly compatible: boolean;
  readonly reason: string | null;
} {
  if (args.stored.provider !== args.provider) {
    return {
      compatible: false,
      reason: `stored provider ${args.stored.provider} does not match selected provider ${args.provider}`,
    };
  }
  if (args.stored.model !== args.model) {
    return {
      compatible: false,
      reason: `stored model ${renderNullable(args.stored.model)} does not match selected model ${renderNullable(args.model)}`,
    };
  }

  const nextFingerprint = fingerprintOperatorCommand({
    provider: args.provider,
    baseCommand: args.baseCommand,
  });
  if (args.stored.baseCommandFingerprint !== nextFingerprint) {
    return {
      compatible: false,
      reason:
        "stored command fingerprint does not match the selected operator command",
    };
  }

  return {
    compatible: true,
    reason: null,
  };
}

function parseOperatorSessionStateDocument(
  value: unknown,
  filePath: string,
): OperatorSessionStateDocument {
  if (!isRecord(value)) {
    throw new ObservabilityError(
      `Malformed operator session state in ${filePath}; expected an object.`,
    );
  }
  if (value.version !== OPERATOR_SESSION_STATE_SCHEMA_VERSION) {
    throw new ObservabilityError(
      `Unsupported operator session state schema in ${filePath}`,
    );
  }
  if (
    value.provider !== "codex" &&
    value.provider !== "claude" &&
    value.provider !== "custom"
  ) {
    throw new ObservabilityError(
      `Malformed operator session state in ${filePath}; expected provider.`,
    );
  }
  if (typeof value.baseCommandFingerprint !== "string") {
    throw new ObservabilityError(
      `Malformed operator session state in ${filePath}; expected baseCommandFingerprint.`,
    );
  }
  if (
    typeof value.backendSessionId !== "string" ||
    value.backendSessionId === ""
  ) {
    throw new ObservabilityError(
      `Malformed operator session state in ${filePath}; expected backendSessionId.`,
    );
  }
  if (
    typeof value.createdAt !== "string" ||
    typeof value.lastUsedAt !== "string"
  ) {
    throw new ObservabilityError(
      `Malformed operator session state in ${filePath}; expected timestamps.`,
    );
  }
  if (value.lastMode !== "fresh" && value.lastMode !== "resuming") {
    throw new ObservabilityError(
      `Malformed operator session state in ${filePath}; expected lastMode.`,
    );
  }
  if (typeof value.lastSummary !== "string") {
    throw new ObservabilityError(
      `Malformed operator session state in ${filePath}; expected lastSummary.`,
    );
  }
  if (value.model !== null && typeof value.model !== "string") {
    throw new ObservabilityError(
      `Malformed operator session state in ${filePath}; expected model.`,
    );
  }

  return {
    version: OPERATOR_SESSION_STATE_SCHEMA_VERSION,
    provider: value.provider,
    model: value.model,
    baseCommandFingerprint: value.baseCommandFingerprint,
    backendSessionId: value.backendSessionId,
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt,
    lastMode: value.lastMode,
    lastSummary: value.lastSummary,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function renderNullable(value: string | null): string {
  return value ?? "(default)";
}
