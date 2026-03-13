export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * When true, info/warn logs are suppressed (the TUI owns the terminal)
 * and only errors go to stderr.  Set by the dashboard on start/stop.
 */
let tuiActive = false;

export function setLogStderr(enabled: boolean): void {
  tuiActive = enabled;
}

function write(
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
): void {
  // While the TUI is rendering, suppress all log output — both stdout and
  // stderr render to the same terminal and would flash between TUI frames.
  // Error state is visible in the TUI's backoff queue.
  if (tuiActive) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data ?? {}),
  };
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(entry)}\n`);
}

export class JsonLogger implements Logger {
  info(message: string, data?: Record<string, unknown>): void {
    write("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    write("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    write("error", message, data);
  }
}
