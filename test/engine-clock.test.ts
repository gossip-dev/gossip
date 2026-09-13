import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { connectV2Engine } from "../src/engine.js";
import { verifyGossipV2HttpRequest } from "../src/http-auth-v2.js";
import { IDENTITY_SESSION_TOOLS } from "../src/identity-session.js";
import {
  MAX_ABSOLUTE_CLOCK_SKEW_SECONDS,
  SERVER_TIME_FRESHNESS_MS,
} from "../src/transport.js";

const endpoint = "https://gossip.test/mcp";
const audience = "https://gossip.test/";

function capabilities(now: number, issuedAtOffsetSeconds = -10) {
  const feature = (capability: string) => ({
    capability,
    status: "verified",
    evidence_revision: "synthetic",
  });
  return {
    protocols: ["gossip/2-draft.1"],
    schema_revisions: ["2026-09-09"],
    auth_profiles: ["gossip-eip191-v2"],
    mcp_revision: "2025-11-25",
    server: { id: "synthetic-engine", revision: "test" },
    endpoint,
    audience,
    issued_at: now + issuedAtOffsetSeconds,
    expires_at: now + 600,
    limits: {
      max_request_bytes: 65_536,
      max_depth: 16,
      max_collection_items: 256,
    },
    features: [
      feature("atomic_consult"),
      feature("durable_operations"),
      feature("signed_receipts"),
      feature("evidence"),
    ],
  };
}

function jsonResponse(id: number, result: unknown, serverNow: number) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "synthetic-session",
      Date: new Date(serverNow * 1_000).toUTCString(),
    },
  });
}

async function exerciseBoundedClockSkew(
  skewDirection: -1 | 1,
  issuedAtOffsetSeconds = -10,
) {
  const wallet = Wallet.createRandom();
  let serverNow = 2_000_000_000;
  let capabilityCalls = 0;
  const nonces = new Set<string>();
  const send: typeof fetch = async (input) => {
    const request = new Request(input);
    const body = new Uint8Array(await request.clone().arrayBuffer());
    try {
      const verified = verifyGossipV2HttpRequest(
        {
          audience,
          endpoint,
          method: request.method,
          target: "/mcp",
          body,
          headers: Object.fromEntries(request.headers.entries()),
        },
        serverNow,
        { audience, endpoint },
      );
      if (nonces.has(verified.nonce)) {
        throw new Error("replayed nonce");
      }
      nonces.add(verified.nonce);
    } catch {
      return new Response(null, {
        status: 401,
        headers: { Date: new Date(serverNow * 1_000).toUTCString() },
      });
    }

    const message = (await request.json()) as {
      id?: number;
      method: string;
      params?: { name?: string };
    };
    if (message.method === "initialize") {
      return jsonResponse(
        message.id!,
        {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic-engine", version: "test" },
        },
        serverNow,
      );
    }
    if (message.method === "notifications/initialized") {
      return new Response(null, {
        status: 202,
        headers: { Date: new Date(serverNow * 1_000).toUTCString() },
      });
    }
    if (message.method === "tools/list") {
      return jsonResponse(
        message.id!,
        {
          tools: IDENTITY_SESSION_TOOLS.map((name) => ({
            name,
            inputSchema: { type: "object" },
          })),
        },
        serverNow,
      );
    }
    if (message.method === "tools/call") {
      assert.equal(message.params?.name, "gossip_capabilities");
      capabilityCalls++;
      const report = capabilities(serverNow, issuedAtOffsetSeconds);
      return jsonResponse(
        message.id!,
        {
          structuredContent: report,
          content: [{ type: "text", text: JSON.stringify(report) }],
        },
        serverNow,
      );
    }
    throw new Error(`Unexpected MCP method: ${message.method}`);
  };
  const localNowMs = () =>
    (serverNow + skewDirection * (MAX_ABSOLUTE_CLOCK_SKEW_SECONDS - 1)) * 1_000;

  const engine = await connectV2Engine(
    wallet,
    { endpoint, audience, profile: "gossip-eip191-v2" },
    send,
    localNowMs,
  );
  try {
    assert.equal(await engine.serverNowSeconds(), serverNow);
    const callsAfterConnect = capabilityCalls;

    serverNow += Math.floor(SERVER_TIME_FRESHNESS_MS / 1_000) + 1;
    assert.equal(await engine.serverNowSeconds(), serverNow);
    assert.equal(capabilityCalls, callsAfterConnect + 1);
    assert.ok(nonces.size >= 6);
    assert.equal(
      [...nonces].every((nonce) => /^[0-9a-f-]+$/u.test(nonce)),
      true,
    );
  } finally {
    await engine.close();
  }
}

test("v2 engine connects and refreshes with bounded host clock skew", async () => {
  await exerciseBoundedClockSkew(-1);
  await exerciseBoundedClockSkew(1);
});

test("v2 engine accepts capability issuance in the next HTTP Date second", async () => {
  await exerciseBoundedClockSkew(1, 1);
});

test("v2 engine reports missing authoritative server time clearly", async () => {
  await assert.rejects(
    connectV2Engine(
      Wallet.createRandom(),
      { endpoint, audience, profile: "gossip-eip191-v2" },
      async () => new Response(null, { status: 401 }),
    ),
    /valid Date header for trusted server time/u,
  );
});
