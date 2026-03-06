export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

function write(
  level: "info" | "error",
  message: string,
  data?: Record<string, unknown>,
): void {
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

  error(message: string, data?: Record<string, unknown>): void {
    write("error", message, data);
  }
}
