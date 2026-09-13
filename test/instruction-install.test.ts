import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installInstructions,
  uninstallInstructions,
} from "../src/instruction-install.js";

const run = promisify(execFile);
const cli = [
  join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
  "src/cli.ts",
];

test("instruction installation is idempotent and preserves an existing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-instructions-"));
  const file = join(directory, "AGENTS.md");
  const original = "# Project rules\r\n\r\nKeep this text exactly\r\n";

  try {
    await writeFile(file, original, "utf8");
    const first = await installInstructions(file);
    const installed = await readFile(file, "utf8");
    const second = await installInstructions(file);

    assert.equal(first.changed, true);
    assert.match(first.digest, /^[0-9a-f]{64}$/u);
    assert.equal(second.changed, false);
    assert.equal(await readFile(file, "utf8"), installed);
    assert.match(installed, /gossip:instructions:start digest=sha256:/u);
    assert.match(installed, /gossip:instructions:end/u);
    assert.match(installed, /Keep this text exactly\r\n/u);
    assert.equal(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")).length,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uninstall restores the original bytes and creates a backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-instructions-"));
  const file = join(directory, "AGENTS.md");
  const original = "user text without a final newline";

  try {
    await writeFile(file, original, "utf8");
    await installInstructions(file);
    const installed = await readFile(file, "utf8");
    const result = await uninstallInstructions(file);

    assert.equal(result.changed, true);
    assert.ok(result.backupPath);
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(await readFile(result.backupPath!, "utf8"), installed);
    assert.equal((await uninstallInstructions(file)).changed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("edited, duplicated, and incomplete managed blocks fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-instructions-"));
  const file = join(directory, "AGENTS.md");

  try {
    await installInstructions(file);
    const installed = await readFile(file, "utf8");
    await writeFile(file, installed.replace("Preserve", "Change"), "utf8");
    await assert.rejects(() => installInstructions(file), /block was edited/u);

    await writeFile(file, `${installed}\n${installed}`, "utf8");
    await assert.rejects(() => uninstallInstructions(file), /duplicated/u);

    await writeFile(
      file,
      "<!-- gossip:instructions:start digest=sha256:" +
        "0".repeat(64) +
        " -->\n",
      "utf8",
    );
    await assert.rejects(() => installInstructions(file), /incomplete/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized instruction files are rejected without modification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-instructions-"));
  const file = join(directory, "AGENTS.md");
  const content = "x".repeat(1024 * 1024 + 1);
  try {
    await writeFile(file, content, "utf8");
    await assert.rejects(() => installInstructions(file), /1 MiB limit/u);
    assert.equal(await readFile(file, "utf8"), content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("symlinked instruction files are rejected without replacement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-instructions-"));
  const target = join(directory, "target.md");
  const link = join(directory, "AGENTS.md");

  try {
    await writeFile(target, "keep\n", "utf8");
    try {
      await symlink(target, link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symlink creation is unavailable on this Windows runner");
        return;
      }
      throw error;
    }
    await assert.rejects(() => installInstructions(link), /symlinked/u);
    assert.equal(await readFile(target, "utf8"), "keep\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an active instruction lock fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-instructions-"));
  const file = join(directory, "AGENTS.md");
  const lock = `${file}.gossip-instructions-lock`;

  try {
    await writeFile(lock, "busy", "utf8");
    await assert.rejects(
      () => installInstructions(file),
      /Another Gossip instruction update is in progress/u,
    );
    await assert.rejects(() => access(file));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI installs and uninstalls instructions through the process seam", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-instructions-"));
  const file = join(directory, "AGENTS.md");

  try {
    const installed = await run(process.execPath, [
      ...cli,
      "instructions",
      "install",
      "--file",
      file,
    ]);
    assert.equal(JSON.parse(installed.stdout).changed, true);

    const removed = await run(process.execPath, [
      ...cli,
      "instructions",
      "uninstall",
      "--file",
      file,
    ]);
    assert.equal(JSON.parse(removed.stdout).changed, true);
    await access(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
