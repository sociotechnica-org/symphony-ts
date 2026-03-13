import fs from "node:fs";
import nodePath from "node:path";

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * When set, all log output goes to this file descriptor instead of the
 * terminal.  Opened by the TUI dashboard on start, closed on stop.
 */
let logFd: number | null = null;
let logFilePath: string | null = null;

export function setLogFile(filePath: string | null): void {
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch {
      // best-effort
    }
    logFd = null;
  }
  logFilePath = filePath;
  if (filePath !== null) {
    fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
    logFd = fs.openSync(filePath, "a");
  }
}

export function getLogFilePath(): string | null {
  return logFilePath;
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
  const line = `${JSON.stringify(entry)}\n`;

  if (logFd !== null) {
    try {
      fs.writeSync(logFd, line);
    } catch {
      // best-effort — don't crash if the log file is unavailable
    }
    return;
  }

  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(line);
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
