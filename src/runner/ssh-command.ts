import { quoteShellToken } from "./local-command.js";

export function buildSshRemoteCommand(args: readonly string[]): string {
  return args.map((arg) => quoteShellToken(arg)).join(" ");
}

