import {
  inspectFactoryControl,
  renderFactoryControlStatus,
  type FactoryControlStatusSnapshot,
} from "./factory-control.js";
import {
  defaultClearScreen,
  renderWatchError,
  renderWatchFrame,
} from "../observability/factory-watch-render.js";
import { isAbortError } from "../support/abort.js";

const DEFAULT_WATCH_INTERVAL_MS = 1_000;

export interface FactoryWatchDeps {
  readonly workflowPath?: string | null;
  readonly inspectFactoryControl?: (options?: {
    readonly workflowPath?: string | null;
  }) => Promise<FactoryControlStatusSnapshot>;
  readonly renderFactoryControlStatus?: (
    snapshot: FactoryControlStatusSnapshot,
    options?: {
      readonly format?: "human" | "json";
    },
  ) => string;
  readonly writeStdout?: (chunk: string) => void;
  readonly isStdoutTTY?: () => boolean;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly clearScreen?: () => string;
  readonly onSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
  readonly offSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
}

export async function watchFactory(deps: FactoryWatchDeps = {}): Promise<void> {
  const inspect = deps.inspectFactoryControl ?? inspectFactoryControl;
  const render = deps.renderFactoryControlStatus ?? renderFactoryControlStatus;
  const writeStdout =
    deps.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  const isStdoutTTY = deps.isStdoutTTY ?? (() => Boolean(process.stdout.isTTY));
  const sleep = deps.sleep ?? sleepWithAbort;
  const clearScreen = deps.clearScreen ?? defaultClearScreen;
  const onSignal =
    deps.onSignal ?? ((signal, listener) => process.on(signal, listener));
  const offSignal =
    deps.offSignal ?? ((signal, listener) => process.off(signal, listener));

  const abortController = new AbortController();
  const stopWatching = (): void => {
    abortController.abort();
  };

  onSignal("SIGINT", stopWatching);
  onSignal("SIGTERM", stopWatching);

  try {
    while (!abortController.signal.aborted) {
      const inspectOptions =
        deps.workflowPath === undefined
          ? undefined
          : { workflowPath: deps.workflowPath };
      const body = await inspect(inspectOptions)
        .then((snapshot) => render(snapshot, { format: "human" }))
        .catch((error: unknown) => renderWatchError(error));
      const frame = renderWatchFrame(body, isStdoutTTY(), clearScreen);
      writeStdout(frame);

      await sleep(DEFAULT_WATCH_INTERVAL_MS, abortController.signal).catch(
        (error: unknown) => {
          if (isAbortError(error)) {
            return;
          }
          throw error;
        },
      );
    }
  } finally {
    offSignal("SIGINT", stopWatching);
    offSignal("SIGTERM", stopWatching);
  }
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw createAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createAbortError(): Error {
  const error = new Error("Factory watch aborted.");
  error.name = "AbortError";
  return error;
}
