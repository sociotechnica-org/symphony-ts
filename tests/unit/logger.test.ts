import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";

describe("JsonLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes info logs to stdout and error logs to stderr", () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const logger = new JsonLogger();

    logger.info("info message", { issueNumber: 1 });
    logger.error("error message", { issueNumber: 2 });

    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stdout.mock.calls[0]?.[0])).toContain('"level":"info"');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('"level":"error"');
  });
});
