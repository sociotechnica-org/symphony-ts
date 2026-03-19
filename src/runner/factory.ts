import type { AgentConfig, SshWorkerHostConfig } from "../domain/workflow.js";
import type { Logger } from "../observability/logger.js";
import type { TrackerToolService } from "../tracker/tool-service.js";
import { ClaudeCodeRunner } from "./claude-code.js";
import { CodexRunner } from "./codex.js";
import { GenericCommandRunner } from "./generic-command.js";
import type { Runner } from "./service.js";

export function createRunner(
  config: AgentConfig,
  logger: Logger,
  options?: {
    readonly remoteWorkerHosts?: Readonly<
      Record<string, SshWorkerHostConfig>
    > | null;
    readonly trackerToolService?: TrackerToolService | null;
  },
): Runner {
  switch (config.runner.kind) {
    case "codex":
      return new CodexRunner(
        config,
        logger,
        options?.trackerToolService ?? null,
        options?.remoteWorkerHosts ?? null,
      );
    case "generic-command":
      return new GenericCommandRunner(config, logger);
    case "claude-code":
      return new ClaudeCodeRunner(config, logger);
  }
}
