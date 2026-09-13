import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { test } from "node:test";
import solc from "solc";
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  getAddress,
} from "ethers";
import {
  quoteExactInputSingle,
  QUOTER_V2,
  SWAP_ROUTER02,
  V3_FACTORY,
} from "../src/dex.js";

const tokenInAddress = "0x1000000000000000000000000000000000000001";
const tokenOutAddress = "0x1000000000000000000000000000000000000002";
const poolAddress = "0x1000000000000000000000000000000000000003";
const mnemonic = "test test test test test test test test test test test junk";
const execute = promisify(execFile);

function compileFixture(): Record<
  string,
  { abi: any[]; bytecode: string; deployedBytecode: string }
> {
  const source = readFileSync(
    new URL("./contracts/DexFixture.sol", import.meta.url),
    "utf8",
  );
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "DexFixture.sol": { content: source } },
        settings: {
          outputSelection: {
            "*": {
              "*": [
                "abi",
                "evm.bytecode.object",
                "evm.deployedBytecode.object",
              ],
            },
          },
        },
      }),
    ),
  );
  assert.equal(
    output.errors?.some(
      (error: { severity: string }) => error.severity === "error",
    ) ?? false,
    false,
  );
  return Object.fromEntries(
    Object.entries(output.contracts["DexFixture.sol"]).map(
      ([name, artifact]: [string, any]) => [
        name,
        {
          abi: artifact.abi,
          bytecode: `0x${artifact.evm.bytecode.object}`,
          deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
        },
      ],
    ),
  );
}

test("quotes and executes exact-input through a controlled chain4663 RPC", async () => {
  const require = createRequire(import.meta.url);
  const packageName =
    process.platform === "win32" && process.arch === "x64"
      ? "@foundry-rs/anvil-win32-amd64"
      : undefined;
  if (!packageName)
    throw new Error(
      `No Anvil fixture binary package for ${process.platform}/${process.arch}`,
    );
  const packageJson = require.resolve(`${packageName}/package.json`);
  const binary = join(
    dirname(packageJson),
    "bin",
    process.platform === "win32" ? "anvil.exe" : "anvil",
  );
  const child = spawn(
    binary,
    [
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--chain-id",
      "4663",
      "--accounts",
      "2",
      "--balance",
      "10000",
      "--mnemonic",
      mnemonic,
    ],
    { windowsHide: true },
  );
  const port = await waitForAnvilPort(child);
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`);
  const signer = new NonceManager(
    new Wallet(
      HDNodeWallet.fromPhrase(
        mnemonic,
        undefined,
        "m/44'/60'/0'/0/0",
      ).privateKey,
      provider,
    ),
  );
  const artifacts = compileFixture();
  try {
    const deploy = async (name: string, ...args: unknown[]) =>
      new ContractFactory(
        artifacts[name].abi,
        artifacts[name].bytecode,
        signer,
      ).deploy(...args);
    const tokenIn = await deploy("DexToken");
    await tokenIn.waitForDeployment();
    const tokenOut = await deploy("DexToken");
    await tokenOut.waitForDeployment();
    const pool = await deploy("DexPool");
    await pool.waitForDeployment();
    const factory = await deploy("DexFactory", await pool.getAddress());
    await factory.waitForDeployment();
    const quoter = await deploy("DexQuoter");
    await quoter.waitForDeployment();
    const router = await deploy("DexRouter");
    await router.waitForDeployment();
    for (const [address, code] of [
      [tokenInAddress, await tokenIn.getDeployedCode()],
      [tokenOutAddress, await tokenOut.getDeployedCode()],
      [poolAddress, await pool.getDeployedCode()],
      [V3_FACTORY, await factory.getDeployedCode()],
      [QUOTER_V2, await quoter.getDeployedCode()],
      [SWAP_ROUTER02, await router.getDeployedCode()],
    ] as const) {
      assert.ok(code);
      await provider.send("anvil_setCode", [address, code]);
    }
    const input = new Contract(tokenInAddress, artifacts.DexToken.abi, signer);
    const output = new Contract(
      tokenOutAddress,
      artifacts.DexToken.abi,
      provider,
    );
    const recipient = await signer.getAddress();
    await (await input.mint(recipient, 1_000n)).wait();
    await (await input.approve(getAddress(SWAP_ROUTER02), 1_000n)).wait();
    const quote = await quoteExactInputSingle({
      provider,
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      amountIn: 1_000n,
      fee: 3000,
      slippageBps: 100,
      deadlineSecs: 300,
      recipient,
      nowSecs: Math.floor(Date.now() / 1000),
    });
    assert.equal(quote.quotedAmountOut, 2_000n);
    assert.equal(quote.amountOutMinimum, 1_980n);
    await (await signer.sendTransaction(quote.transaction)).wait();
    assert.equal(await output.balanceOf(recipient), 2_000n);
    const expired = await quoteExactInputSingle({
      provider,
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      amountIn: 1n,
      fee: 3000,
      slippageBps: 0,
      deadlineSecs: 1,
      recipient,
      nowSecs: 0,
    });
    await assert.rejects(
      signer.sendTransaction(expired.transaction),
      /expired|revert/i,
    );
    await assert.rejects(
      quoteExactInputSingle({
        provider,
        tokenIn: tokenInAddress,
        tokenOut: tokenOutAddress,
        amountIn: 1n,
        fee: 3000,
        slippageBps: 10_000,
        deadlineSecs: 60,
        recipient,
      }),
      /slippageBps/,
    );
    await assert.rejects(
      quoteExactInputSingle({
        provider,
        tokenIn: tokenInAddress,
        tokenOut: tokenOutAddress,
        amountIn: 2n ** 256n,
        fee: 3000,
        slippageBps: 0,
        deadlineSecs: 60,
        recipient,
      }),
      /amountIn/,
    );
    await assert.rejects(
      quoteExactInputSingle({
        provider,
        tokenIn: tokenInAddress,
        tokenOut: tokenOutAddress,
        amountIn: 1n,
        fee: 3000,
        slippageBps: 0,
        deadlineSecs: 0,
        recipient,
      }),
      /deadlineSecs/,
    );
    await assert.rejects(
      quoteExactInputSingle({
        provider,
        tokenIn: tokenInAddress,
        tokenOut: tokenOutAddress,
        amountIn: 1n,
        fee: 3000,
        slippageBps: 0,
        deadlineSecs: 60,
        recipient: "0x0000000000000000000000000000000000000000",
      }),
      /recipient/,
    );

    const directory = await mkdtemp(join(tmpdir(), "gossip-dex-cli-"));
    const state = join(directory, "state");
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
    let loseBroadcastReply = true;
    const proxy = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        if (
          JSON.parse(body).method === "eth_sendRawTransaction" &&
          loseBroadcastReply
        ) {
          loseBroadcastReply = false;
          res.destroy();
          return;
        }
        const response = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
      },
    );
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyAddress = proxy.address();
    assert(proxyAddress && typeof proxyAddress !== "string");
    const cli = ["node_modules/tsx/dist/cli.mjs", "src/cli.ts"];
    const cliEnv = { ...process.env, NODE_EXTRA_CA_CERTS: cert };
    try {
      const source = join(directory, "wallet.key");
      await writeFile(
        source,
        HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0")
          .privateKey,
        { mode: 0o600 },
      );
      await execute(
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
          recipient,
          "--directory",
          state,
        ],
        { env: cliEnv },
      );
      await execute(
        process.execPath,
        [
          ...cli,
          "network",
          "configure",
          "--rpc",
          `https://127.0.0.1:${proxyAddress.port}`,
          "--directory",
          state,
        ],
        { env: cliEnv },
      );
      const cliResult = await execute(
        process.execPath,
        [
          ...cli,
          "trade",
          "quote",
          "--address",
          recipient,
          "--token-in",
          tokenInAddress,
          "--token-out",
          tokenOutAddress,
          "--amount-in",
          "1000",
          "--fee",
          "3000",
          "--slippage-bps",
          "100",
          "--deadline-seconds",
          "300",
          "--directory",
          state,
        ],
        { env: cliEnv },
      );
      const cliQuote = JSON.parse(cliResult.stdout);
      assert.equal(cliQuote.quotedAmountOut, "2000");
      assert.equal(cliQuote.amountOutMinimum, "1980");
      assert.equal(cliQuote.executionAuthorized, false);
      signer.reset();
      await (await input.mint(recipient, 1000n)).wait();
      // Explicit owner-supplied local policy is test input, never a production grant.
      const permission = {
        schemaVersion: 1,
        id: "fixture-swap",
        enabled: true,
        quote: cliQuote,
        gasLimit: "500000",
        maxFeePerGas: "10000000000",
      };
      const executeTrade = () =>
        execute(
          process.execPath,
          [
            ...cli,
            "trade",
            "execute",
            "--id",
            "fixture-swap",
            "--directory",
            state,
          ],
          { env: cliEnv },
        );
      for (const invalid of [
        { ...permission, enabled: false },
        { ...permission, gasLimit: "1" },
        {
          ...permission,
          quote: {
            ...cliQuote,
            transaction: { ...cliQuote.transaction, data: "0x" },
          },
        },
      ]) {
        await writeFile(
          join(state, "trade-permission.json"),
          JSON.stringify(invalid),
        );
        await assert.rejects(executeTrade);
        assert.equal(await output.balanceOf(recipient), 2000n);
      }
      await writeFile(
        join(state, "trade-permission.json"),
        JSON.stringify(permission),
      );
      await executeTrade();
      await execute(
        process.execPath,
        [...cli, "trade", "revoke", "--directory", state],
        { env: cliEnv },
      );
      const revokedResult = JSON.parse((await executeTrade()).stdout);
      assert.equal(revokedResult.executionAuthorized, false);
      assert.equal(
        await output.balanceOf(recipient),
        2000n,
        "revocation must prevent the swap after approval",
      );
      await writeFile(
        join(state, "trade-permission.json"),
        JSON.stringify(permission),
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        await execute(
          process.execPath,
          [
            ...cli,
            "trade",
            "execute",
            "--id",
            "fixture-swap",
            "--directory",
            state,
          ],
          { env: cliEnv },
        );
      }
      assert.equal(await output.balanceOf(recipient), 4000n);
      await execute(
        process.execPath,
        [
          ...cli,
          "trade",
          "execute",
          "--id",
          "fixture-swap",
          "--directory",
          state,
        ],
        { env: cliEnv },
      );
      assert.equal(
        await output.balanceOf(recipient),
        4000n,
        "retries must not repeat a swap",
      );
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    provider.destroy();
    child.kill();
  }
});

async function waitForAnvilPort(
  child: ChildProcessWithoutNullStreams,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/Listening on 127\.0\.0\.1:(\d+)/);
      if (match) {
        cleanup();
        resolve(Number(match[1]));
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Anvil exited before startup (${code}): ${output}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
