import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHost, uninstallHost } from "../src/host-install.js";

async function tempConfig(
  name: string,
  content: string,
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gossip-host-"));
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return { dir, path };
}

test("Hermes install preserves comments, existing servers, and is idempotent", async () => {
  const { dir, path } = await tempConfig(
    "config.yaml",
    "# keep this comment\nmcp_servers:\n  other:\n    command: other\n",
  );
  try {
    const first = await installHost("hermes", path, "gossip", ["serve"]);
    assert.equal(first.changed, true);
    const text = await readFile(path, "utf8");
    assert.match(text, /keep this comment/);
    assert.match(text, /other:/);
    assert.match(text, /gossip:/);
    const second = await installHost("hermes", path, "gossip", ["serve"]);
    assert.equal(second.changed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpenClaw install and uninstall only touch the exact Gossip entry", async () => {
  const { dir, path } = await tempConfig(
    "openclaw.json",
    JSON.stringify({
      mcp: { servers: { other: { command: "other", args: [] } } },
    }),
  );
  try {
    await installHost("openclaw", path, "gossip", ["serve"]);
    const installed = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(installed.mcp.servers.other, {
      command: "other",
      args: [],
    });
    const removed = await uninstallHost("openclaw", path, "gossip", ["serve"]);
    assert.equal(removed.changed, true);
    const final = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(final.mcp.servers, {
      other: { command: "other", args: [] },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing config is created with a private mode and an existing config gets a unique backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gossip-host-"));
  const missing = join(dir, "nested", "config.yaml");
  try {
    const created = await installHost("hermes", missing, "gossip", ["serve"]);
    assert.equal(created.changed, true);
    assert.equal(created.backupPath, undefined);
    if (process.platform !== "win32")
      assert.deepEqual((await stat(missing)).mode & 0o777, 0o600);

    const existing = join(dir, "existing.yaml");
    await writeFile(existing, "mcp_servers: {}\n", "utf8");
    const updated = await installHost("hermes", existing, "gossip", ["serve"]);
    assert.equal(updated.changed, true);
    assert.ok(updated.backupPath);
    await access(updated.backupPath!);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("conflicts, symlinks, and Grok fail closed without overwriting", async (t) => {
  const { dir, path } = await tempConfig(
    "config.yaml",
    "mcp_servers:\n  gossip:\n    command: other\n    args: []\n",
  );
  const link = join(dir, "link.yaml");
  try {
    await assert.rejects(
      () => installHost("hermes", path, "gossip", ["serve"]),
      /conflicts/i,
    );
    const before = await readFile(path, "utf8");
    await assert.rejects(
      () => installHost("grok-bot", path, "gossip", ["serve"]),
      /agent-only AddMcpServer/i,
    );
    assert.equal(await readFile(path, "utf8"), before);
    try {
      await symlink(path, link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symlink creation is unavailable on this Windows runner");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => installHost("hermes", link, "gossip", ["serve"]),
      /symlink/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed roots and scalar intermediate paths fail without replacement", async () => {
  const malformed = await tempConfig(
    "bad.yaml",
    "mcp_servers: [unterminated\n",
  );
  const scalar = await tempConfig(
    "scalar.json",
    JSON.stringify({ mcp: "owned-by-user" }),
  );
  try {
    await assert.rejects(
      () => installHost("hermes", malformed.path, "gossip", ["serve"]),
      /Malformed YAML|YAML/i,
    );
    await assert.rejects(
      () => installHost("openclaw", scalar.path, "gossip", ["serve"]),
      /non-object/i,
    );
    assert.equal(
      await readFile(scalar.path, "utf8"),
      JSON.stringify({ mcp: "owned-by-user" }),
    );
    await assert.rejects(
      () => installHost("other" as never, scalar.path, "gossip", ["serve"]),
      /unsupported host/i,
    );
  } finally {
    await rm(malformed.dir, { recursive: true, force: true });
    await rm(scalar.dir, { recursive: true, force: true });
  }
});

test("concurrent updates serialize and cannot clobber a different command", async () => {
  const { dir, path } = await tempConfig("config.json", "{}");
  try {
    const results = await Promise.allSettled([
      installHost("openclaw", path, "gossip-a", ["serve"]),
      installHost("openclaw", path, "gossip-b", ["serve"]),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    const final = JSON.parse(await readFile(path, "utf8"));
    assert.equal(final.mcp.servers.gossip.args[0], "serve");
    assert.match(final.mcp.servers.gossip.command, /^gossip-[ab]$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uninstall preserves a user-modified Gossip entry", async () => {
  const { dir, path } = await tempConfig("config.json", "{}");
  try {
    await installHost("openclaw", path, "gossip", ["serve"]);
    const modified = JSON.parse(await readFile(path, "utf8"));
    modified.mcp.servers.gossip.args = ["serve", "--changed"];
    await writeFile(path, JSON.stringify(modified), "utf8");
    const result = await uninstallHost("openclaw", path, "gossip", ["serve"]);
    assert.equal(result.changed, false);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), modified);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uninstall preserves added user settings on an otherwise unchanged entry", async () => {
  const { dir, path } = await tempConfig("config.json", "{}");
  try {
    await installHost("openclaw", path, "gossip", ["serve"]);
    const modified = JSON.parse(await readFile(path, "utf8"));
    modified.mcp.servers.gossip.env = { USER_SETTING: "keep" };
    await writeFile(path, JSON.stringify(modified), "utf8");
    assert.equal(
      (await uninstallHost("openclaw", path, "gossip", ["serve"])).changed,
      false,
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), modified);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
