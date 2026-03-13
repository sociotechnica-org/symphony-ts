export function parseLandingCommandSignal(body: string): boolean {
  const firstLine = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");

  return firstLine?.toLowerCase() === "/land";
}
