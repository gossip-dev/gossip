import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const run = promisify(execFile);

test("trading reports disabled without reading keys or creating state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-trade-"));
  try {
    const result = await run(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      "src/cli.ts",
      "trade",
      "status",
      "--directory",
      directory,
    ]);
    assert.equal(JSON.parse(result.stdout).executionAuthorized, false);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trade authorization refuses non-interactive confirmation without creating permission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-trade-"));
  try {
    const result = await run(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      "src/cli.ts",
      "trade",
      "authorize",
      "--directory",
      directory,
    ]).catch((error) => error);
    assert.match(result.stderr, /interactive terminal/i);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
