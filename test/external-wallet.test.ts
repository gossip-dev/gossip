import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, verifyMessage } from "ethers";
import {
  GOSSIP_V2_HEADERS,
  verifyGossipV2HttpRequest,
} from "../src/http-auth-v2.js";
import { createV2SignedFetch } from "../src/transport.js";
import { WalletVault } from "../src/wallet.js";

const unavailableStore = {
  read: async () => {
    throw new Error("keyring absent");
  },
  write: async () => {
    throw new Error("keyring absent");
  },
  remove: async () => {
    throw new Error("keyring absent");
  },
};

test("attach reuses an existing file wallet without keyring access or source mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gossip-attach-"));
  const source = join(root, "owner-wallet.json");
  const wallet = Wallet.createRandom();
  const content = JSON.stringify({ privateKey: wallet.privateKey });
  await writeFile(source, content, { mode: 0o600 });
  const directory = join(root, "gossip");
  const vault = new WalletVault(directory, unavailableStore);
  try {
    await vault.attachFile(wallet.address, {
      keyFile: source,
      format: "json-privateKey",
    });
    assert.equal((await vault.create()).address, wallet.address);
    const reopened = new WalletVault(directory, unavailableStore);
    const signer = await reopened.signer();
    const message = "Gossip signer verification v1\nsynthetic";
    assert.equal(
      verifyMessage(message, await signer.signMessage(message)),
      wallet.address,
    );
    await assert.rejects(
      signer.signMessage("arbitrary message"),
      /unsupported Gossip signing message/,
    );
    const profile = await readFile(join(directory, "wallet.json"), "utf8");
    assert.ok(!profile.includes(wallet.privateKey));
    await vault.remove();
    assert.equal(await readFile(source, "utf8"), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attached json-private_key signer authenticates a v2 HTTP request", async () => {
  const root = await mkdtemp(join(tmpdir(), "gossip-attach-v2-"));
  const source = join(root, "owner-wallet.json");
  const wallet = Wallet.createRandom();
  await writeFile(source, JSON.stringify({ private_key: wallet.privateKey }), {
    mode: 0o600,
  });
  const directory = join(root, "gossip");
  const vault = new WalletVault(directory, unavailableStore);
  const endpoint = "https://gossip.test/mcp";
  const audience = "https://gossip.test/";
  let captured: Request | undefined;

  try {
    await vault.attachFile(wallet.address, {
      keyFile: source,
      format: "json-private_key",
    });
    const signer = await vault.signer();
    const signed = createV2SignedFetch(
      signer,
      { endpoint, audience },
      async (input, init) => {
        captured = new Request(input, init);
        return new Response("{}", {
          headers: {
            "content-type": "application/json",
            Date: new Date().toUTCString(),
          },
        });
      },
    );
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';

    await signed(endpoint, { method: "POST", body });

    assert.ok(captured);
    const bodyBytes = new Uint8Array(await captured.clone().arrayBuffer());
    const verified = verifyGossipV2HttpRequest(
      {
        audience,
        endpoint,
        method: captured.method,
        target: "/mcp",
        body: bodyBytes,
        headers: Object.fromEntries(captured.headers.entries()),
      },
      Math.floor(Date.now() / 1000),
      { audience, endpoint },
    );
    assert.equal(verified.address, wallet.address.toLowerCase());
    assert.equal(
      captured.headers.get(GOSSIP_V2_HEADERS.profile),
      "gossip-eip191-v2",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing source cannot be replaced by wallet creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gossip-source-"));
  const source = join(root, "key");
  const wallet = Wallet.createRandom();
  await writeFile(source, wallet.privateKey, { mode: 0o600 });
  const directory = join(root, "gossip");
  const vault = new WalletVault(directory, unavailableStore);
  try {
    await vault.attachFile(wallet.address, {
      keyFile: source,
      format: "raw-hex",
    });
    await rm(source);
    await assert.rejects(vault.create(), /signing failed/);
    assert.equal((await vault.identity()).address, wallet.address);
    await assert.rejects(vault.backup("unused"), /owner tools/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
test("CLI attaches without a keyring and refuses unsupported profile activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gossip-cli-attach-"));
  const source = join(root, "key");
  const wallet = Wallet.createRandom();
  await writeFile(source, wallet.privateKey, { mode: 0o600 });
  const directory = join(root, "state");
  const cli = [
    join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
    join(process.cwd(), "src/cli.ts"),
  ];
  const env = { ...process.env, PATH: "", DBUS_SESSION_BUS_ADDRESS: "" };
  try {
    const attached = await run(
      process.execPath,
      [
        ...cli,
        "wallet",
        "attach-file",
        "--file",
        source,
        "--format",
        "raw-hex",
        "--address",
        wallet.address,
        "--directory",
        directory,
      ],
      { env },
    );
    assert.equal(JSON.parse(attached.stdout).address, wallet.address);
    await assert.rejects(
      run(
        process.execPath,
        [
          ...cli,
          "setup",
          "--endpoint",
          "https://gossip.test/mcp",
          "--audience",
          "https://gossip.test",
          "--profile",
          "erc8128",
          "--directory",
          directory,
        ],
        { env },
      ),
    );
    await assert.rejects(readFile(join(directory, "config.yaml")));
    await run(
      process.execPath,
      [
        ...cli,
        "setup",
        "--endpoint",
        "https://gossip.test/mcp",
        "--audience",
        "https://gossip.test",
        "--directory",
        directory,
      ],
      { env },
    );
    const status = await run(
      process.execPath,
      [...cli, "status", "--directory", directory],
      { env },
    );
    assert.equal(
      JSON.parse(status.stdout).configuredStorageAdapter,
      "existing-key-file",
    );
    assert.equal(JSON.parse(status.stdout).connected, false);
    assert.equal(await readFile(source, "utf8"), wallet.privateKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
