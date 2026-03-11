export class SymphonyError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class WorkflowError extends SymphonyError {
  constructor(message: string, options?: ErrorOptions) {
    super("workflow_error", message, options);
  }
}

export class ConfigError extends SymphonyError {
  constructor(message: string, options?: ErrorOptions) {
    super("config_error", message, options);
  }
}

export class TrackerError extends SymphonyError {
  constructor(message: string, options?: ErrorOptions) {
    super("tracker_error", message, options);
  }
}

export class IntegrationError extends SymphonyError {
  constructor(message: string, options?: ErrorOptions) {
    super("integration_error", message, options);
  }
}

export class WorkspaceError extends SymphonyError {
  constructor(message: string, options?: ErrorOptions) {
    super("workspace_error", message, options);
  }
}

export class RunnerError extends SymphonyError {
  constructor(message: string, options?: ErrorOptions) {
    super("runner_error", message, options);
  }
}

export class RunnerAbortedError extends SymphonyError {
  constructor(message: string, options?: ErrorOptions) {
    super("runner_aborted", message, options);
  }
}

export class ObservabilityError extends SymphonyError {
  constructor(message: string, options?: ErrorOptions) {
    super("observability_error", message, options);
  }
}

export class OrchestratorError extends SymphonyError {
  constructor(message: string, options?: ErrorOptions) {
    super("orchestrator_error", message, options);
  }
}
