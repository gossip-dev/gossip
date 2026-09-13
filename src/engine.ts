import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { IdentitySigner } from "./transport.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Connection } from "./transport.js";
import { createSignedFetch, createV2SignedFetch } from "./transport.js";
import { ServerClockError } from "./transport.js";
import type { Engine } from "./kit.js";
import type { V2Engine } from "./kit-v2.js";
import { IDENTITY_SESSION_TOOLS } from "./identity-session.js";
import { ProtocolError } from "./protocol-errors.js";
import { z } from "zod";
import {
  MCP_REVISION,
  AUTH_PROFILE,
  negotiateCapabilities,
} from "./protocol-v2.js";

const allowedTools = new Set([
  "agent_access",
  "agent_consult",
  "gossip_submit",
  "gossip_receipt",
]);

const v2ToolsDiscoverySchema = z.object({
  tools: z.array(
    z.object({
      name: z
        .string()
        .min(1)
        .refine((name) => name === name.trim()),
    }),
  ),
  nextCursor: z.string().optional(),
});

export async function connectEngine(
  wallet: IdentitySigner,
  connection: Connection,
): Promise<Engine & { close(): Promise<void> }> {
  const client = new Client({
    name: "gossip-agent-kit",
    version: "0.1.0-dev.1",
  });
  const signedFetch = createSignedFetch(wallet, connection);
  const boundedFetch: typeof fetch = (input, init) =>
    signedFetch(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
  const transport = new StreamableHTTPClientTransport(
    new URL(connection.endpoint),
    { fetch: boundedFetch },
  );
  try {
    // SDK declares sessionId as required-but-undefined on this transport and optional on Transport.
    await client.connect(transport as Transport, { timeout: 20_000 });
    const discovery = await client.listTools();
    for (const required of allowedTools) {
      if (!discovery.tools.some((tool) => tool.name === required))
        throw new Error("Engine lacks a required Gossip tool.");
    }
  } catch {
    await client.close().catch(() => undefined);
    throw new Error(
      "Engine connection failed. Verify endpoint, HTTPS trust and signing-profile support.",
    );
  }
  return {
    async call(tool, arguments_) {
      if (!allowedTools.has(tool))
        throw new Error("Unsupported Gossip operation.");
      const response = await client.callTool(
        { name: tool, arguments: arguments_ },
        undefined,
        { timeout: 20_000 },
      );
      if (response.isError)
        throw new Error(
          "Engine rejected the operation. Check access; retry with the same logical operation ID.",
        );
      if (response.structuredContent) return response.structuredContent;
      if (Array.isArray(response.content)) {
        const text = response.content.find((block) => block.type === "text");
        if (text && typeof text.text === "string") {
          try {
            return JSON.parse(text.text) as unknown;
          } catch {
            /* malformed engine response */
          }
        }
      }
      throw new Error("Invalid engine response.");
    },
    close: () => client.close(),
  };
}

export async function connectV2Engine(
  wallet: IdentitySigner,
  connection: Connection,
  send: typeof fetch = fetch,
  localNowMs: () => number = Date.now,
): Promise<V2Engine & { close(): Promise<void> }> {
  if (connection.profile !== "gossip-eip191-v2") {
    throw new Error("Gossip v2 engine requires the gossip-eip191-v2 profile.");
  }

  const client = new Client({
    name: "gossip-agent-kit",
    version: "0.1.0-dev.1",
  });
  const allowedTools = new Set<string>(IDENTITY_SESSION_TOOLS);
  const signedFetch = createV2SignedFetch(wallet, connection, send, localNowMs);
  const boundedFetch: typeof fetch = (input, init) =>
    signedFetch(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
  const transport = new StreamableHTTPClientTransport(
    new URL(connection.endpoint),
    { fetch: boundedFetch },
  );

  try {
    await client.connect(transport as Transport, { timeout: 20_000 });
    const discovery = await client.request(
      { method: "tools/list" },
      v2ToolsDiscoverySchema,
    );
    const discovered = new Set(discovery.tools.map((tool) => tool.name));
    if ([...allowedTools].some((tool) => !discovered.has(tool))) {
      throw new Error("Engine lacks a required Gossip v2 tool.");
    }

    const capabilities = await callTool(client, "gossip_capabilities", {});
    negotiateCapabilities(
      capabilities,
      {
        endpoint: connection.endpoint,
        audience: connection.audience,
        mcp_revision: MCP_REVISION,
        auth_profile: AUTH_PROFILE,
      },
      signedFetch.serverNowSeconds(),
    );
  } catch (error) {
    await client.close().catch(() => undefined);
    if (error instanceof ServerClockError) {
      throw error;
    }
    if (
      error instanceof ProtocolError &&
      error.code === "unsupported_capability"
    ) {
      throw new Error(
        "Engine connection is pending because required Gossip v2 capabilities are not verified.",
      );
    }
    throw new Error(
      "Engine connection failed. Verify endpoint, HTTPS trust, v2 capabilities and signing-profile support.",
    );
  }

  return {
    async call(tool, arguments_) {
      if (!allowedTools.has(tool))
        throw new Error("Unsupported Gossip v2 operation.");
      return callTool(client, tool, arguments_);
    },
    async serverNowSeconds() {
      try {
        return signedFetch.serverNowSeconds();
      } catch (error) {
        if (!(error instanceof ServerClockError)) {
          throw error;
        }
        await callTool(client, "gossip_capabilities", {});
        return signedFetch.serverNowSeconds();
      }
    },
    close: () => client.close(),
  };
}

async function callTool(
  client: Client,
  tool: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  const response = await client.callTool(
    { name: tool, arguments: arguments_ },
    undefined,
    { timeout: 20_000 },
  );
  if (response.isError) {
    throw new Error("Engine rejected the Gossip v2 operation.");
  }
  if (response.structuredContent) return response.structuredContent;
  if (Array.isArray(response.content)) {
    const text = response.content.find((block) => block.type === "text");
    if (text && typeof text.text === "string") {
      try {
        return JSON.parse(text.text) as unknown;
      } catch {
        /* malformed engine response */
      }
    }
  }
  throw new Error("Invalid Gossip v2 engine response.");
}
