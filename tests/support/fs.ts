import fs from "node:fs/promises";

export async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(root, {
        recursive: true,
        force: true,
      });
      return;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOTEMPTY" ||
        attempt === 4
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
