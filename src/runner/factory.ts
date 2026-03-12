import type { AgentConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import { CodexRunner } from "./codex.js";
import { GenericCommandRunner } from "./generic-command.js";
import type { Runner } from "./service.js";

export function createRunner(config: AgentConfig, logger: Logger): Runner {
  switch (config.runner.kind) {
    case "codex":
      return new CodexRunner(config, logger);
    case "generic-command":
      return new GenericCommandRunner(config, logger);
  }
}
