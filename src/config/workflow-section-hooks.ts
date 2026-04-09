import type { HooksConfig } from "../domain/workflow.js";
import { requireStringArray } from "./workflow-validation.js";

export function resolveHooksConfig(
  raw: Readonly<Record<string, unknown>>,
): HooksConfig {
  return {
    afterCreate:
      raw["after_create"] === undefined
        ? []
        : requireStringArray(raw["after_create"], "hooks.after_create"),
  };
}
