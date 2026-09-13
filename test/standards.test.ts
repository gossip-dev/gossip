import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Wallet, verifyTypedData } from "ethers";

import {
  ERC1271_MAGIC_VALUE,
  buildErc8004AgentWalletTypedData,
  formatChecksumAddress,
  isChecksumAddress,
  prepareErc8004Registration,
  validateErc8004Association,
  verifyErc1271Signature,
} from "../src/standards.js";

test("formats and validates official EIP-55 vectors", () => {
  const address = "0x52908400098527886E0F7030069857D2E4169EE7";
  assert.equal(formatChecksumAddress(address.toLowerCase()), address);
  assert.equal(isChecksumAddress(address), true);
  assert.equal(
    isChecksumAddress("0x52908400098527886e0F7030069857D2E4169EE7"),
    false,
  );
});

test("builds the concrete ERC-8004 AgentWalletSet proof", () => {
  const proof = buildErc8004AgentWalletTypedData({
    chainId: 1,
    registry: "0x0000000000000000000000000000000000008004",
    agentId: 7n,
    newWallet: "0x00000000000000000000000000000000000000a1",
    owner: "0x00000000000000000000000000000000000000b2",
    deadline: 1_800_000_000n,
  });
  assert.deepEqual(proof.types, {
    AgentWalletSet: [
      { name: "agentId", type: "uint256" },
      { name: "newWallet", type: "address" },
      { name: "owner", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  });
  assert.equal(proof.domain.name, "ERC8004IdentityRegistry");
  assert.equal(proof.domain.version, "1");
  assert.equal(proof.message.agentId, 7n);
});

test("prepares validated ERC-8004 registration metadata", () => {
  const metadata = prepareErc8004Registration({
    name: "Gossip",
    description: "Onchain intelligence",
    image: "https://example.test/gossip.png",
    services: [{ name: "MCP", endpoint: "https://example.test/mcp" }],
    registrations: [
      {
        agentRegistry: "eip155:1:0x0000000000000000000000000000000000008004",
        agentId: 7n,
      },
    ],
  });
  assert.equal(
    metadata.type,
    "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  );
  assert.equal(metadata.registrations[0].agentId, "7");
  assert.doesNotThrow(() => JSON.stringify(metadata));
  assert.equal(
    (metadata as unknown as Record<string, unknown>).unexpected,
    undefined,
  );
});

test("verifies ERC-1271 with a read-only eth_call", async () => {
  let call: unknown;
  const provider = {
    call: async (transaction: unknown) => {
      call = transaction;
      return `0x${ERC1271_MAGIC_VALUE.slice(2).padEnd(64, "0")}`;
    },
  } as never;
  assert.equal(
    await verifyErc1271Signature(
      provider,
      "0x00000000000000000000000000000000000000a1",
      "0x" + "11".repeat(32),
      "0x1234",
    ),
    true,
  );
  assert.equal(typeof call, "object");
});

test("fails closed for malformed ERC-1271 replies and RPC errors", async () => {
  const provider = { call: async () => "0x1234" } as never;
  assert.equal(
    await verifyErc1271Signature(
      provider,
      "0x00000000000000000000000000000000000000a1",
      "0x" + "11".repeat(32),
      "0x1234",
    ),
    false,
  );
  const failing = {
    call: async () => {
      throw new Error("rpc");
    },
  } as never;
  assert.equal(
    await verifyErc1271Signature(
      failing,
      "0x00000000000000000000000000000000000000a1",
      "0x" + "11".repeat(32),
      "0x1234",
    ),
    false,
  );
});

test("requires the expected chain, code, owner, and one block tag for ERC-8004 association", async () => {
  const provider = {
    getNetwork: async () => ({ chainId: 1n }),
    getCode: async (_address: string, blockTag: string | number) => {
      assert.equal(blockTag, 123);
      return "0x6000";
    },
    send: async (
      _method: string,
      [tx, blockTag]: [{ data: string }, string | number],
    ) => {
      assert.equal(blockTag, "0x7b");
      return tx.data.endsWith("a6f") ? "0x" : "0x";
    },
  } as never;
  const result = await validateErc8004Association({
    provider,
    registry: "0x0000000000000000000000000000000000008004",
    agentId: 7n,
    wallet: "0x00000000000000000000000000000000000000a1",
    expectedOwner: "0x00000000000000000000000000000000000000b2",
    expectedChainId: 1,
    blockTag: 123,
  });
  assert.equal(result.verified, false);
});

test("typed ERC-8004 proof recovers the known wallet", async () => {
  const wallet = new Wallet(
    "0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a7b3cc7c6f4b6f6a2f1",
  );
  const proof = buildErc8004AgentWalletTypedData({
    chainId: 1,
    registry: "0x0000000000000000000000000000000000008004",
    agentId: 7n,
    newWallet: wallet.address,
    owner: "0x00000000000000000000000000000000000000b2",
    deadline: 1_800_000_000n,
  });
  const signature = await wallet.signTypedData(
    proof.domain,
    proof.types,
    proof.message,
  );
  assert.equal(
    await verifyTypedData(proof.domain, proof.types, proof.message, signature),
    wallet.address,
  );
});

test("rejects invalid ERC-8004 proof bounds", () => {
  assert.throws(() =>
    buildErc8004AgentWalletTypedData({
      chainId: 0,
      registry: "0x0000000000000000000000000000000000008004",
      agentId: 1n,
      newWallet: "0x00000000000000000000000000000000000000a1",
      owner: "0x00000000000000000000000000000000000000b2",
      deadline: 1n,
    }),
  );
  assert.throws(() =>
    buildErc8004AgentWalletTypedData({
      chainId: 1,
      registry: "0x0000000000000000000000000000000000008004",
      agentId: 1n << 256n,
      newWallet: "0x00000000000000000000000000000000000000a1",
      owner: "0x00000000000000000000000000000000000000b2",
      deadline: 1n,
    }),
  );
});
