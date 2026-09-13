import { lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const names = ["setup-gossip", "gossip"];

export async function installSkills(
  directory: string,
): Promise<{ installed: true; changed: boolean }> {
  if (!isAbsolute(directory))
    throw new Error("Skill directory must be absolute");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Skill directory must not be a symlink");
  const lockPath = join(directory, ".gossip-skills.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    const pending: { path: string; content: string }[] = [];
    for (const name of names) {
      const content = await readFile(
        new URL(`../skills/${name}/SKILL.md`, import.meta.url),
        "utf8",
      );
      const folder = join(directory, name);
      try {
        const metadata = await lstat(folder);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new Error("Skill path conflict");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const path = join(folder, "SKILL.md");
      try {
        if (
          (await lstat(path)).isSymbolicLink() ||
          (await readFile(path, "utf8")) !== content
        )
          throw new Error("Existing skill differs; explicit upgrade required");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        pending.push({ path, content });
      }
    }
    for (const entry of pending) {
      await mkdir(join(entry.path, ".."), { recursive: true });
      await writeFile(entry.path, entry.content, { flag: "wx", mode: 0o600 });
    }
    return { installed: true, changed: pending.length > 0 };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
