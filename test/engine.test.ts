import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { IDENTITY_SESSION_TOOLS } from "../src/identity-session.js";
import { connectV2Engine } from "../src/engine.js";

const endpoint = "https://gossip.test/mcp";
const audience = "https://gossip.test/";

function capabilities(now: number) {
  return {
    protocols: ["gossip/2-draft.1"],
    schema_revisions: ["2026-09-09"],
    auth_profiles: ["gossip-eip191-v2"],
    mcp_revision: "2025-11-25",
    server: { id: "synthetic-engine", revision: "test" },
    endpoint,
    audience,
    issued_at: now - 10,
    expires_at: now + 600,
    limits: {
      max_request_bytes: 65_536,
      max_depth: 16,
      max_collection_items: 256,
    },
    features: [
      {
        capability: "atomic_consult",
        status: "verified",
        evidence_revision: "synthetic",
      },
      {
        capability: "durable_operations",
        status: "verified",
        evidence_revision: "synthetic",
      },
      {
        capability: "signed_receipts",
        status: "verified",
        evidence_revision: "synthetic",
      },
      {
        capability: "evidence",
        status: "verified",
        evidence_revision: "synthetic",
      },
    ],
  };
}

function response(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "synthetic-session",
      Date: new Date().toUTCString(),
    },
  });
}

function createFetch(
  report: ReturnType<typeof capabilities>,
  toolNames: readonly unknown[] = IDENTITY_SESSION_TOOLS,
): typeof fetch {
  return (async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "GET") {
      return new Response(null, {
        status: 405,
        headers: { Date: new Date().toUTCString() },
      });
    }
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { Date: new Date().toUTCString() },
      });
    }

    const message = (await request.json()) as {
      id: number;
      method: string;
    };
    if (message.method === "initialize") {
      return response(message.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "synthetic-engine", version: "test" },
      });
    }
    if (message.method === "notifications/initialized") {
      return new Response(null, {
        status: 202,
        headers: { Date: new Date().toUTCString() },
      });
    }
    if (message.method === "tools/list") {
      return response(message.id, {
        tools: toolNames.map((name) => ({
          name,
          inputSchema: { type: "object" },
          outputSchema: {
            type: "object",
            properties: { structuredContent: true },
          },
        })),
      });
    }
    if (message.method === "tools/call") {
      return response(message.id, {
        structuredContent: report,
        content: [{ type: "text", text: JSON.stringify(report) }],
      });
    }
    return new Response(null, {
      status: 400,
      headers: { Date: new Date().toUTCString() },
    });
  }) as typeof fetch;
}

test("v2 engine connects when tools advertise structuredContent output schemas", async () => {
  const originalFetch = globalThis.fetch;
  const wallet = Wallet.createRandom();
  const now = Math.floor(Date.now() / 1000);
  const report = capabilities(now);

  globalThis.fetch = createFetch(report);

  try {
    const engine = await connectV2Engine(wallet, {
      endpoint,
      audience,
      profile: "gossip-eip191-v2",
    });
    await engine.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v2 engine rejects discovery that omits a required tool", async () => {
  const originalFetch = globalThis.fetch;
  const now = Math.floor(Date.now() / 1000);
  const report = capabilities(now);
  globalThis.fetch = createFetch(report, IDENTITY_SESSION_TOOLS.slice(0, -1));

  try {
    await assert.rejects(
      connectV2Engine(Wallet.createRandom(), {
        endpoint,
        audience,
        profile: "gossip-eip191-v2",
      }),
      /Engine connection failed/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v2 engine rejects discovery with a malformed tool name", async () => {
  const originalFetch = globalThis.fetch;
  const now = Math.floor(Date.now() / 1000);
  const report = capabilities(now);
  globalThis.fetch = createFetch(report, [
    ...IDENTITY_SESSION_TOOLS.slice(0, -1),
    null,
  ]);

  try {
    await assert.rejects(
      connectV2Engine(Wallet.createRandom(), {
        endpoint,
        audience,
        profile: "gossip-eip191-v2",
      }),
      /Engine connection failed/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v2 engine reports when required capabilities are not verified", async () => {
  const originalFetch = globalThis.fetch;
  const now = Math.floor(Date.now() / 1000);
  const report = capabilities(now);
  report.features[0] = {
    capability: "atomic_consult",
    status: "blocked",
    reason: "Production verification is pending.",
    next_action: "Complete the production capability tests.",
  };
  globalThis.fetch = createFetch(report);

  try {
    await assert.rejects(
      connectV2Engine(Wallet.createRandom(), {
        endpoint,
        audience,
        profile: "gossip-eip191-v2",
      }),
      /required Gossip v2 capabilities are not verified/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
