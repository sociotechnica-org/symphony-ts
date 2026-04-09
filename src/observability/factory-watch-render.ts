export function renderWatchFrame(
  body: string,
  isTTY: boolean,
  clearScreen: () => string = defaultClearScreen,
): string {
  const lines = [
    "Detached factory watch",
    "Ctrl-C stops this watch client only.",
    "",
    body.endsWith("\n") ? body.slice(0, -1) : body,
  ];
  const prefix = isTTY ? clearScreen() : "";
  return `${prefix}${lines.join("\n")}\n`;
}

export function renderWatchError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Unknown factory watch error.";
  return [
    "Factory control: degraded",
    `Watch error: ${message}`,
    "Status detail: watch will retry on the next poll.",
  ].join("\n");
}

export function defaultClearScreen(): string {
  return "\x1b[2J\x1b[H";
}
