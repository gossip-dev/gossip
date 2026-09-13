import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const execute = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gossip-network-"));
  const cert = join(directory, "cert.pem");
  const key = join(directory, "key.pem");
  const openssl =
    process.platform === "win32"
      ? "C:/Program Files/Git/usr/bin/openssl.exe"
      : "openssl";
  await execute(openssl, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  let chain = "0x1237";
  let mode = "normal";
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const call = JSON.parse(body);
      if (mode === "slow")
        await new Promise((resolve) => setTimeout(resolve, 300));
      if (mode === "redirect") {
        res.writeHead(307, { Location: "https://example.test" }).end();
        return;
      }
      if (mode === "malformed") {
        res.end(JSON.stringify({ result: "0x1237" }));
        return;
      }
      const result =
        call.method === "eth_chainId"
          ? chain
          : call.method === "eth_blockNumber"
            ? "0x64"
            : call.method === "eth_getBalance"
              ? "0xde0b6b3a7640000"
              : {
                  number: "0x64",
                  timestamp: `0x${(Math.floor(Date.now() / 1000) - (mode === "stale" ? 600 : 0)).toString(16)}`,
                };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    url: `https://127.0.0.1:${address.port}/provider-token?key=hidden`,
    changeMode(value: string) {
      mode = value;
    },
    changeChain(value: string) {
      chain = value;
    },
    async run(...args: string[]) {
      return execute(
        process.execPath,
        [
          "node_modules/tsx/dist/cli.mjs",
          "src/cli.ts",
          "network",
          ...args,
          "--directory",
          directory,
        ],
        { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert } },
      );
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("network installation validates the remote chain before saving configuration", async () => {
  const f = await fixture();
  try {
    f.changeChain("0x1");
    await assert.rejects(() => f.run("configure", "--rpc", f.url));
  } finally {
    await f.close();
  }
});

test("network reruns preserve the selected RPC and read integer balances without revealing provider tokens", async () => {
  const f = await fixture();
  try {
    await f.run("configure", "--rpc", f.url);
    const rerun = await f.run("configure");
    assert.ok(!rerun.stdout.includes("provider-token"));
    assert.ok(!rerun.stdout.includes("hidden"));
    const balance = JSON.parse(
      (
        await f.run(
          "balance",
          "--address",
          "0x0000000000000000000000000000000000000001",
        )
      ).stdout,
    );
    assert.equal(balance.balanceWei, "1000000000000000000");
    await assert.rejects(() =>
      f.run("configure", "--rpc", "https://example.test"),
    );
    assert.equal(JSON.parse((await f.run("check")).stdout).chainId, 4663);
  } finally {
    await f.close();
  }
});

test("network checks reject stale blocks, malformed envelopes and redirects", async () => {
  const f = await fixture();
  try {
    for (const mode of ["stale", "malformed", "redirect"]) {
      f.changeMode(mode);
      await assert.rejects(() => f.run("configure", "--rpc", f.url));
    }
  } finally {
    await f.close();
  }
});

test("concurrent RPC setup cannot replace the winning provider", async () => {
  const f = await fixture();
  try {
    f.changeMode("slow");
    const results = await Promise.allSettled([
      f.run("configure", "--rpc", f.url),
      f.run("configure", "--rpc", f.url + "other"),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
  } finally {
    await f.close();
  }
});
