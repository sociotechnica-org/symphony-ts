export async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException;
      if (systemError.code === "ESRCH") {
        return;
      }
      if (systemError.code === "EPERM") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}
