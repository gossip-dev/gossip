import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
const run = promisify(execFile);
const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const entry = join(process.cwd(), "src", "cli.ts");

test("CLI help is public and does not create wallet state", async () => {
  const result = await run(process.execPath, [tsx, entry, "--help"]);
  assert.match(result.stdout, /gossip status/);
});

test("status reports metadata without requiring wallet creation", async () => {
  const result = await run(process.execPath, [
    tsx,
    entry,
    "status",
    "--directory",
    join(process.cwd(), ".missing-cli-test"),
  ]);
  assert.notEqual(result.stdout.trim(), "");
  const parsed = JSON.parse(result.stdout) as {
    kitAvailable: boolean;
    storageVerified: boolean;
    identity: unknown;
  };
  assert.equal(parsed.kitAvailable, true);
  assert.equal(parsed.storageVerified, false);
  assert.equal(parsed.identity, null);
});

test("wallet create is standalone and idempotent without creating configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-cli-wallet-"));
  try {
    const first = await run(process.execPath, [
      tsx,
      entry,
      "wallet",
      "create",
      "--directory",
      directory,
    ]);
    const second = await run(process.execPath, [
      tsx,
      entry,
      "wallet",
      "create",
      "--directory",
      directory,
    ]);
    const firstAddress = (JSON.parse(first.stdout) as { address: string })
      .address;
    const secondAddress = (JSON.parse(second.stdout) as { address: string })
      .address;
    assert.match(firstAddress, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(secondAddress, firstAddress);
    await assert.rejects(() => readFile(join(directory, "config.yaml")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup rejects an HTTP endpoint before creating wallet state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-cli-"));
  try {
    await assert.rejects(() =>
      run(process.execPath, [
        tsx,
        entry,
        "setup",
        "--directory",
        directory,
        "--endpoint",
        "http://localhost",
        "--audience",
        "https://gossip.test",
      ]),
    );
    await assert.rejects(() => readFile(join(directory, "wallet.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup rejects URL credentials and fragments before creating wallet state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-cli-"));
  try {
    await assert.rejects(() =>
      run(process.execPath, [
        tsx,
        entry,
        "setup",
        "--directory",
        directory,
        "--endpoint",
        "https://user:secret@gossip.test",
        "--audience",
        "https://gossip.test/#fragment",
      ]),
    );
    await assert.rejects(() => readFile(join(directory, "wallet.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host install and uninstall operate through the CLI process seam", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-cli-"));
  const config = join(directory, "hermes.yaml");
  try {
    const installed = await run(process.execPath, [
      tsx,
      entry,
      "host-install",
      "--host",
      "hermes",
      "--config",
      config,
      "--directory",
      directory,
    ]);
    assert.equal(JSON.parse(installed.stdout).changed, true);
    const removed = await run(process.execPath, [
      tsx,
      entry,
      "host-uninstall",
      "--host",
      "hermes",
      "--config",
      config,
      "--directory",
      directory,
    ]);
    assert.equal(JSON.parse(removed.stdout).changed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host commands reject relative config paths without writing", async () => {
  await assert.rejects(() =>
    run(process.execPath, [
      tsx,
      entry,
      "host-install",
      "--host",
      "hermes",
      "--config",
      "relative.yaml",
    ]),
  );
});

test("standards reports an EOA and blocks ERC-8128 on the legacy profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-cli-"));
  try {
    await writeFile(
      join(directory, "config.yaml"),
      [
        "schemaVersion: 1",
        "endpoint: https://gossip.test",
        "audience: https://gossip.test",
        "profile: sherwood-eip191-personal-sign-v1",
        "chainId: 4663",
        "enabled: false",
        "policy:",
        "  dailyCreditBudget: 0",
        "  submissionKinds: []",
        "",
      ].join("\n"),
    );
    const result = await run(process.execPath, [
      tsx,
      entry,
      "standards",
      "--directory",
      directory,
    ]);
    const report = JSON.parse(result.stdout) as {
      verified: boolean;
      capabilities: Array<{ standard: string; status: string }>;
    };
    assert.equal(report.verified, false);
    assert.equal(
      report.capabilities.find((item) => item.standard === "ERC-1271")?.status,
      "not-applicable",
    );
    assert.equal(
      report.capabilities.find((item) => item.standard === "ERC-8128")?.status,
      "blocked-legacy-engine",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup refuses to replace a corrupt configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-cli-"));
  const configPath = join(directory, "config.yaml");
  try {
    await writeFile(configPath, "corrupt: [");
    await assert.rejects(() =>
      run(process.execPath, [
        tsx,
        entry,
        "setup",
        "--directory",
        directory,
        "--endpoint",
        "https://gossip.test",
        "--audience",
        "https://gossip.test",
      ]),
    );
    assert.equal(await readFile(configPath, "utf8"), "corrupt: [");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
