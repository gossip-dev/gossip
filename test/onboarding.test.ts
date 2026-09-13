import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { loadConfiguration } from "../src/configuration.js";
const run = promisify(execFile);
const cli = [
  join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
  "src/cli.ts",
];

test("setup-gossip inspection reports missing prerequisites without creating a wallet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-onboard-"));
  try {
    const result = await run(process.execPath, [
      ...cli,
      "setup-gossip",
      "--host",
      "grok-bot",
      "--directory",
      directory,
    ]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.wallet.status, "pending");
    assert.equal(report.gossip.status, "pending");
    assert.equal(report.host.verified, false);
    assert.equal(report.host.format, "agent-tool");
    assert.equal(report.host.configuration.tool, "AddMcpServer");
    assert.equal(report.host.configuration.arguments.command, process.execPath);
    const hostArgs = report.host.configuration.arguments.args;
    assert.equal(isAbsolute(hostArgs[0]), true);
    assert.match(hostArgs[0], /dist[\\/]cli\.js$/u);
    assert.deepEqual(hostArgs.slice(1), ["serve", "--directory", directory]);
    assert.match(report.host.nextStep, /AddMcpServer/);
    assert.equal(report.trading.executionAuthorized, false);
    for (const standard of ["EIP-55", "EIP-191"]) {
      assert.match(
        report.standards.find(
          (item: { standard: string }) => item.standard === standard,
        ).nextStep,
        /select.*wallet/i,
      );
    }
    assert.deepEqual(
      report.standards
        .map((item: { standard: string }) => item.standard)
        .sort(),
      ["EIP-191", "EIP-55", "EIP-712", "ERC-1271", "ERC-8004", "ERC-8128"],
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup-gossip verifies an attached wallet without requiring a keyring or an engine", async () => {
  const { Wallet } = await import("ethers");
  const { writeFile, readFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "gossip-onboard-"));
  const source = join(directory, "source.key");
  const state = join(directory, "state");
  const identity = Wallet.createRandom();
  try {
    await writeFile(source, identity.privateKey, { mode: 0o600 });
    const arguments_ = [
      ...cli,
      "setup-gossip",
      "--host",
      "grok-bot",
      "--directory",
      state,
      "--wallet",
      "attach-file",
      "--file",
      source,
      "--format",
      "raw-hex",
      "--address",
      identity.address,
    ];
    const first = JSON.parse((await run(process.execPath, arguments_)).stdout);
    const second = JSON.parse((await run(process.execPath, arguments_)).stdout);
    assert.equal(first.wallet.status, "verified");
    assert.equal(second.wallet.address, identity.address);
    assert.equal(first.gossip.connected, false);
    assert.equal(
      first.standards.find(
        (item: { standard: string }) => item.standard === "ERC-8128",
      ).status,
      "blocked",
    );
    assert.equal(await readFile(source, "utf8"), identity.privateKey);
    assert.ok(!JSON.stringify(first).includes(identity.privateKey));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup-gossip rejects unsupported options before changing wallet state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-onboard-"));
  try {
    await assert.rejects(() =>
      run(process.execPath, [
        ...cli,
        "setup-gossip",
        "--host",
        "grok-bot",
        "--wallet",
        "create",
        "--trade",
        "unlimited",
        "--directory",
        directory,
      ]),
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup-gossip refuses a partial endpoint before creating a wallet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-onboard-"));
  try {
    await assert.rejects(() =>
      run(process.execPath, [
        ...cli,
        "setup-gossip",
        "--host",
        "hermes",
        "--wallet",
        "create",
        "--endpoint",
        "https://example.test/mcp",
        "--directory",
        directory,
      ]),
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup-gossip keeps a verified wallet when the configured engine is unavailable", async () => {
  const { Wallet } = await import("ethers");
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "gossip-onboard-"));
  const identity = Wallet.createRandom();
  const source = join(directory, "source.key");
  try {
    await writeFile(source, identity.privateKey, { mode: 0o600 });
    const result = await run(process.execPath, [
      ...cli,
      "setup-gossip",
      "--host",
      "grok-bot",
      "--directory",
      join(directory, "state"),
      "--wallet",
      "attach-file",
      "--file",
      source,
      "--format",
      "raw-hex",
      "--address",
      identity.address,
      "--endpoint",
      "https://127.0.0.1:1/mcp",
      "--audience",
      "https://127.0.0.1:1",
      "--profile",
      "gossip-eip191-v2",
    ]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.wallet.status, "verified");
    assert.equal(report.gossip.connected, false);
    assert.equal(report.gossip.configured, true);
    assert.equal(
      (await loadConfiguration(join(directory, "state"))).profile,
      "gossip-eip191-v2",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup-gossip installs host configuration additively through the setup entry point", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "gossip-onboard-"));
  const config = join(directory, "hermes.yaml");
  try {
    await writeFile(config, "model: keep-this\n");
    const result = await run(process.execPath, [
      ...cli,
      "setup-gossip",
      "--host",
      "hermes",
      "--config",
      config,
      "--directory",
      join(directory, "state"),
    ]);
    assert.equal(JSON.parse(result.stdout).host.configured, true);
    assert.match(await readFile(config, "utf8"), /keep-this/);
    assert.match(await readFile(config, "utf8"), /mcp_servers/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup-gossip reports an unavailable RPC independently of wallet and Gossip readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-onboard-"));
  try {
    const result = await run(process.execPath, [
      ...cli,
      "setup-gossip",
      "--host",
      "grok-bot",
      "--network",
      "configure",
      "--rpc",
      "https://127.0.0.1:1",
      "--directory",
      directory,
    ]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.network.status, "pending");
    assert.equal(report.gossip.connected, false);
    assert.equal(report.trading.executionAuthorized, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup-gossip refuses to replace a missing identity in an existing installation", async () => {
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "gossip-onboard-"));
  try {
    await writeFile(join(directory, "config.yaml"), "existing: true\n");
    await assert.rejects(() =>
      run(process.execPath, [
        ...cli,
        "setup-gossip",
        "--host",
        "grok-bot",
        "--wallet",
        "create",
        "--directory",
        directory,
      ]),
    );
    assert.deepEqual(await readdir(directory), ["config.yaml"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup-gossip installs its skills into the selected host skill directory and preserves reruns", async () => {
  const { readFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "gossip-onboard-"));
  const skills = join(directory, "skills");
  try {
    const args = [
      ...cli,
      "setup-gossip",
      "--host",
      "grok-bot",
      "--skills-directory",
      skills,
      "--directory",
      join(directory, "state"),
    ];
    const first = JSON.parse((await run(process.execPath, args)).stdout);
    const second = JSON.parse((await run(process.execPath, args)).stdout);
    assert.equal(first.skills.installed, true);
    assert.equal(second.skills.changed, false);
    assert.match(
      await readFile(join(skills, "setup-gossip", "SKILL.md"), "utf8"),
      /name: setup-gossip/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
