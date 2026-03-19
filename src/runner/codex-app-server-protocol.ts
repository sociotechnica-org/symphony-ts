import { RunnerError } from "../domain/errors.js";

export type CodexAppServerSessionState =
  | "idle"
  | "starting-process"
  | "initializing"
  | "starting-thread"
  | "ready"
  | "starting-turn"
  | "streaming-turn"
  | "awaiting-approval"
  | "turn-succeeded"
  | "turn-failed"
  | "closing"
  | "closed";

export type CodexAppServerFailureClass =
  | "startup-transport-failure"
  | "initialize-transport-failure"
  | "thread-start-transport-failure"
  | "turn-start-transport-failure"
  | "approval-transport-failure"
  | "unsupported-request-failure"
  | "malformed-terminal-payload"
  | "active-turn-transport-failure"
  | "turn-timeout";

export class CodexAppServerTransportError extends RunnerError {
  readonly failureClass: CodexAppServerFailureClass;

  constructor(
    failureClass: CodexAppServerFailureClass,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.failureClass = failureClass;
  }
}

export type CodexAppServerMessage =
  | CodexAppServerResponseMessage
  | CodexAppServerRequestMessage
  | CodexAppServerNotificationMessage;

export interface CodexAppServerResponseMessage {
  readonly kind: "response";
  readonly id: unknown;
  readonly result: Record<string, unknown> | null;
  readonly error: unknown;
}

export interface CodexAppServerRequestMessage {
  readonly kind: "request";
  readonly id: string | number;
  readonly method: string;
  readonly rawParams: unknown;
  readonly params: Record<string, unknown> | null;
}

export interface CodexAppServerNotificationMessage {
  readonly kind: "notification";
  readonly method: string;
  readonly rawParams: unknown;
  readonly params: Record<string, unknown> | null;
}

export interface CodexAppServerApprovalRequest {
  readonly kind: "command" | "file-change";
  readonly summary: string;
}

export function classifyCodexAppServerMessage(
  payload: unknown,
): CodexAppServerMessage | null {
  const message = asRecord(payload);
  if (message === null) {
    return null;
  }

  const id = message["id"];
  const method =
    typeof message["method"] === "string" ? message["method"] : null;

  if ((typeof id === "number" || typeof id === "string") && method !== null) {
    return {
      kind: "request",
      id,
      method,
      rawParams: message["params"],
      params: asRecord(message["params"]),
    };
  }

  if (id !== undefined) {
    return {
      kind: "response",
      id,
      result: asRecord(message["result"]),
      error: message["error"],
    };
  }

  if (method !== null) {
    return {
      kind: "notification",
      method,
      rawParams: message["params"],
      params: asRecord(message["params"]),
    };
  }

  return null;
}

export function extractCodexApprovalRequest(
  request: CodexAppServerRequestMessage,
): CodexAppServerApprovalRequest | null {
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const command = extractCommandText(request.params);
      if (command === null) {
        throw new CodexAppServerTransportError(
          "approval-transport-failure",
          "Codex app-server sent a malformed command approval request",
        );
      }
      return {
        kind: "command",
        summary: command,
      };
    }
    case "item/fileChange/requestApproval": {
      const count =
        request.params?.["fileChangeCount"] ?? request.params?.["changeCount"];
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
        throw new CodexAppServerTransportError(
          "approval-transport-failure",
          "Codex app-server sent a malformed file-change approval request",
        );
      }
      return {
        kind: "file-change",
        summary: `${count} files`,
      };
    }
    default:
      return null;
  }
}

export function formatCodexTransportError(
  error: Error,
  fallbackClass: CodexAppServerFailureClass,
): string {
  const failureClass =
    error instanceof CodexAppServerTransportError
      ? error.failureClass
      : fallbackClass;
  return `${failureClass}: ${error.message}`;
}

export function createCodexApprovalResponse(
  requestId: string | number,
): Record<string, unknown> {
  return {
    id: requestId,
    result: {
      decision: "approved",
    },
  };
}

export function createCodexInvalidParamsResponse(
  requestId: string | number,
  method: string,
  message: string,
): Record<string, unknown> {
  return createCodexErrorResponse(requestId, -32602, `${method}: ${message}`);
}

export function createCodexUnsupportedRequestResponse(
  requestId: string | number,
  method: string,
): Record<string, unknown> {
  return createCodexErrorResponse(
    requestId,
    -32601,
    `Unsupported Codex app-server request '${method}'`,
  );
}

function createCodexErrorResponse(
  requestId: string | number,
  code: number,
  message: string,
): Record<string, unknown> {
  return {
    id: requestId,
    error: {
      code,
      message,
    },
  };
}

function extractCommandText(
  params: Record<string, unknown> | null,
): string | null {
  if (params === null) {
    return null;
  }

  const direct =
    params["command"] ?? params["cmd"] ?? params["commandText"] ?? null;
  if (typeof direct === "string" && direct.trim() !== "") {
    return direct.trim();
  }

  if (Array.isArray(direct)) {
    const parts = direct.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }

  const command = asRecord(direct);
  const commandText = command?.["text"];
  if (typeof commandText === "string" && commandText.trim() !== "") {
    return commandText.trim();
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
