import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export async function withTradeLock<T>(
  directory: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "trade.lock");
  const lock = await open(path, "wx", 0o600);
  try {
    return await action();
  } finally {
    await lock.close();
    await rm(path, { force: true });
  }
}

export async function writeTradeFile(
  directory: string,
  name: string,
  value: unknown,
): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, name));
  } finally {
    await rm(temporary, { force: true });
  }
}
