export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * When true, all log levels write to stderr so the TUI has exclusive
 * use of stdout.  Set by the dashboard on start/stop.
 */
let forceStderr = false;

export function setLogStderr(enabled: boolean): void {
  forceStderr = enabled;
}

function write(
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data ?? {}),
  };
  const stream =
    forceStderr || level === "error" ? process.stderr : process.stdout;
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
