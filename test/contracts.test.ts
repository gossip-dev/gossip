import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import solc from "solc";
import {
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  Wallet,
  keccak256,
  toUtf8Bytes,
} from "ethers";

import { verifyErc1271Signature } from "../src/standards.js";

function compileFixture(): { abi: unknown[]; bytecode: string } {
  const source = readFileSync(
    new URL("./contracts/Mock1271.sol", import.meta.url),
    "utf8",
  );
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "Mock1271.sol": { content: source } },
        settings: {
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
        },
      }),
    ),
  );
  const artifact = output.contracts["Mock1271.sol"].Mock1271;
  assert.equal(
    output.errors?.some(
      (error: { severity: string }) => error.severity === "error",
    ) ?? false,
    false,
  );
  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
}

test("verifies ERC-1271 against a real local contract and rejects altered proofs", async () => {
  // Fixed public test mnemonic; these accounts are local-only and have no external value.
  const mnemonic =
    "test test test test test test test test test test test junk";
  const ownerKey = HDNodeWallet.fromPhrase(
    mnemonic,
    undefined,
    "m/44'/60'/0'/0/0",
  ).privateKey;
  const otherKey = HDNodeWallet.fromPhrase(
    mnemonic,
    undefined,
    "m/44'/60'/0'/0/1",
  ).privateKey;
  const require = createRequire(import.meta.url);
  const packageName =
    process.platform === "win32" && process.arch === "x64"
      ? "@foundry-rs/anvil-win32-amd64"
      : undefined;
  if (packageName === undefined)
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
      "--accounts",
      "2",
      "--balance",
      "10000",
      "--mnemonic",
      "test test test test test test test test test test test junk",
    ],
    { windowsHide: true },
  );
  const port = await waitForAnvilPort(child);
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`);
  const signer = new Wallet(ownerKey, provider);
  try {
    const owner = await signer.getAddress();
    const artifact = compileFixture();
    const contract = await new ContractFactory(
      artifact.abi,
      artifact.bytecode,
      signer,
    ).deploy(owner);
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    const digest = keccak256(toUtf8Bytes("gossip synthetic ERC-1271 proof"));
    const signature = signer.signingKey.sign(digest);
    const serialized = signature.serialized;

    assert.equal(
      await verifyErc1271Signature(provider, address, digest, serialized),
      true,
    );
    assert.equal(
      await verifyErc1271Signature(
        provider,
        address,
        keccak256(toUtf8Bytes("altered")),
        serialized,
      ),
      false,
    );
    const wrongSignature = new Wallet(otherKey).signingKey.sign(
      digest,
    ).serialized;
    assert.equal(
      await verifyErc1271Signature(provider, address, digest, wrongSignature),
      false,
    );
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
