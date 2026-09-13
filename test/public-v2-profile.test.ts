import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GossipV2Kit } from "../src/kit-v2.js";
import { createV2Bridge } from "../src/bridge.js";
import { Wallet } from "ethers";
import { WalletVault } from "../src/wallet.js";
import { createCredentialStore } from "../src/credential-store.js";
import { prepareConnection } from "../src/setup-connection.js";
import { loadConfiguration } from "../src/configuration.js";
import {
  AUTH_PROFILE,
  MCP_REVISION,
  PROTOCOL_REVISION,
  SCHEMA_REVISION,
} from "../src/protocol-v2.js";
import { ProtocolError } from "../src/protocol-errors.js";
import { canonicalJson, parseCanonicalJson } from "../src/canonical.js";

const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const endpoint = "https://gossip.test/mcp";
const audience = "https://gossip.test/";

const publicSubmissionFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/v2-public-submission.json", import.meta.url),
    "utf8",
  ),
) as { valid: Record<string, unknown> };

const publicSubmissionReceiptFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/v2-public-submission-receipt.json", import.meta.url),
    "utf8",
  ),
) as { receipt: Record<string, unknown> };

function feature(capability: string) {
  return { capability, status: "verified", evidence_revision: "engine-1" };
}

function capabilities() {
  return {
    protocols: [PROTOCOL_REVISION],
    schema_revisions: [SCHEMA_REVISION],
    auth_profiles: [AUTH_PROFILE],
    mcp_revision: MCP_REVISION,
    server: { id: "sherwood", revision: "engine-1" },
    endpoint,
    audience,
    issued_at: 1_000,
    expires_at: 2_000,
    limits: {
      max_request_bytes: 32_768,
      max_depth: 8,
      max_collection_items: 128,
    },
    features: [
      feature("atomic_consult"),
      feature("durable_operations"),
      feature("signed_receipts"),
      feature("evidence"),
    ],
  };
}

test("setup accepts the installable v2 profile for an existing EOA file", async () => {
  const root = await mkdtemp(join(tmpdir(), "gossip-v2-setup-"));
  const source = join(root, "owner.key");
  const wallet = Wallet.createRandom();
  await writeFile(source, wallet.privateKey, { mode: 0o600 });
  const directory = join(root, "state");
  try {
    const vault = new WalletVault(directory, createCredentialStore(directory));
    await vault.attachFile(wallet.address, {
      keyFile: source,
      format: "raw-hex",
    });
    await prepareConnection(directory, [
      "--endpoint",
      "https://gossip.test/mcp",
      "--audience",
      "https://gossip.test/",
      "--profile",
      "gossip-eip191-v2",
    ]);
    assert.equal(
      (await loadConfiguration(directory)).profile,
      "gossip-eip191-v2",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the v2 kit uses authoritative server time for capability expiry and consultation deadlines", async () => {
  let calls = 0;
  const kit = new GossipV2Kit(
    "unused",
    address,
    {
      call: async () => {
        calls++;
        return capabilities();
      },
      serverNowSeconds: async () => 2_000,
    },
    { endpoint, audience },
  );

  await assert.rejects(
    kit.capabilities(),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "expired_capabilities",
  );
  await assert.rejects(
    kit.consult({
      protocol: PROTOCOL_REVISION,
      schema_revision: SCHEMA_REVISION,
      auth_profile: AUTH_PROFILE,
      operation_id: "expired_consultation",
      actor: { chain_id: "4663", address: address.toLowerCase() },
      subject: {
        kind: "token",
        chain_id: "4663",
        address: "0x2222222222222222222222222222222222222222",
      },
      capability: "token_overview",
      endpoint,
      audience,
      quality: {
        tier: "standard",
        max_age_seconds: 300,
        finality: "safe",
        allow_partial: false,
      },
      max_cost: { unit: "earned_credit", amount: "0" },
      deadline: 2_000,
    }),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "expired_deadline",
  );
  assert.equal(calls, 1);
});

test("consult sends canonical JSON property order to the engine", async () => {
  let wireRequest: unknown;
  const kit = new GossipV2Kit(
    "unused",
    address,
    {
      call: async (_tool, arguments_) => {
        wireRequest = arguments_.request;
        parseCanonicalJson(JSON.stringify(wireRequest));
        return {
          protocol: PROTOCOL_REVISION,
          schema_revision: SCHEMA_REVISION,
          schema: "gossip.operation.v2",
          operation_id: "canonical-consultation",
          status: "accepted",
          economic_state: "free",
          version: 0,
          reserved_amount: "0",
          unmet_requirements: [],
        };
      },
      serverNowSeconds: async () => 1_000,
    },
    { endpoint, audience },
  );

  await kit.consult({
    protocol: PROTOCOL_REVISION,
    schema_revision: SCHEMA_REVISION,
    auth_profile: AUTH_PROFILE,
    operation_id: "canonical-consultation",
    actor: { chain_id: "4663", address: address.toLowerCase() },
    subject: {
      kind: "token",
      chain_id: "4663",
      address: "0x2222222222222222222222222222222222222222",
    },
    capability: "token_overview",
    endpoint,
    audience,
    quality: {
      tier: "standard",
      max_age_seconds: 300,
      finality: "safe",
      allow_partial: false,
    },
    max_cost: { unit: "earned_credit", amount: "0" },
    deadline: 1_300,
  });

  const serializedRequest = JSON.stringify(wireRequest);
  assert.equal(serializedRequest, canonicalJson(wireRequest));
});

test("submit sends canonical JSON property order to the engine", async () => {
  let wireRequest: unknown;
  const validSubmission = publicSubmissionFixture.valid;
  const actor = validSubmission.actor as { address: string };
  const submissionEndpoint = validSubmission.endpoint as string;
  const submissionAudience = validSubmission.audience as string;
  const kit = new GossipV2Kit(
    "unused",
    actor.address,
    {
      call: async (_tool, arguments_) => {
        wireRequest = arguments_.request;
        parseCanonicalJson(JSON.stringify(wireRequest));
        return publicSubmissionReceiptFixture.receipt;
      },
      serverNowSeconds: async () => 1_000,
    },
    { endpoint: submissionEndpoint, audience: submissionAudience },
  );

  await kit.submit(validSubmission);

  const serializedRequest = JSON.stringify(wireRequest);
  assert.equal(serializedRequest, canonicalJson(wireRequest));
});

test("the v2 bridge exposes exactly the six v2 tools and never forwards feedback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-v2-bridge-"));
  let calls = 0;
  const kit = new GossipV2Kit(
    directory,
    address,
    {
      call: async () => {
        calls++;
        return {};
      },
      serverNowSeconds: async () => 1_000,
    },
    { endpoint, audience },
  );
  const server = createV2Bridge(kit);
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left);
    await client.connect(right);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [
        "gossip_capabilities",
        "gossip_consult_v2",
        "gossip_feedback",
        "gossip_operation",
        "gossip_receipt_v2",
        "gossip_submit_v2",
      ],
    );
    const result = await client.callTool({
      name: "gossip_feedback",
      arguments: { request: {} },
    });
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
  } finally {
    await client.close();
    await server.close();
    kit.close();
    await rm(directory, { recursive: true, force: true });
  }
});
