import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

interface AtomicWriteOptions {
  readonly tempPrefix?: string | undefined;
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options?: AtomicWriteOptions,
): Promise<void> {
  await writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    tempPrefix: options?.tempPrefix,
  });
}

export async function writeTextFileAtomic(
  filePath: string,
  content: string,
  options?: AtomicWriteOptions,
): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPrefix = options?.tempPrefix ?? ".atomic-write";
  const tempPath = path.join(
    directory,
    `${tempPrefix}.${process.pid.toString()}.${randomUUID()}.tmp`,
  );

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(tempPath, content, "utf8");
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
