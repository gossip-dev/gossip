import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GossipKit } from "./kit.js";
import { operationId, submissionSchema } from "./schemas.js";
import { consultationSchema, operationIdV2Schema } from "./protocol-v2.js";
import { publicSubmissionSchema } from "./public-submission-v1.js";

export function createBridge(
  kit: GossipKit,
  beforeCall: () => Promise<void> = async () => {},
) {
  const server = new McpServer({
    name: "gossip-agent-kit",
    version: "0.1.0-dev.1",
  });
  async function invoke(operation: () => Promise<unknown>) {
    try {
      await beforeCall();
      const result = await operation();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const safe = message.startsWith("Submission permission")
        ? "Submission permission is required. Ask the user to configure permitted Gossip kinds locally."
        : message.includes("budget")
          ? "Credit budget is exhausted or not authorized. Legacy engines cannot guarantee standard-only reads."
          : message.includes("different content")
            ? "Operation ID conflicts with earlier content. Reuse an ID only for the same logical operation."
            : message.includes("disconnected")
              ? "Gossip is disconnected. Reconnect through the local setup tool."
              : "Gossip operation failed. Check the local connection and access status. Keep the same operation ID when retrying.";
      return {
        isError: true,
        content: [{ type: "text" as const, text: safe }],
      };
    }
  }
  server.registerTool(
    "agent_access",
    {
      description: "Check your actual Gossip access.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => invoke(() => kit.access()),
  );
  server.registerTool(
    "agent_consult",
    {
      description:
        "Consult token evidence. A durable operation ID and configured credit budget are required.",
      inputSchema: {
        client_id: operationId,
        token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      },
    },
    (args) => invoke(() => kit.consult(args.client_id, args.token)),
  );
  server.registerTool(
    "gossip_submit",
    {
      description:
        "Submit private context only within user-configured permission. Retry with the same client_id and content.",
      inputSchema: { submission: submissionSchema },
    },
    (args) => invoke(() => kit.submit(args.submission)),
  );
  server.registerTool(
    "gossip_receipt",
    {
      description: "Read your own receipt outcome.",
      inputSchema: { receipt_id: z.uuid() },
      annotations: { readOnlyHint: true },
    },
    (args) => invoke(() => kit.receipt(args.receipt_id)),
  );
  return server;
}

export function createV2Bridge(
  kit: GossipV2Kit,
  beforeCall: () => Promise<void> = async () => {},
) {
  const server = new McpServer({
    name: "gossip-agent-kit",
    version: "0.1.0-dev.1",
  });

  async function invoke(operation: () => Promise<unknown>) {
    try {
      await beforeCall();
      const result = await operation();
      return {
        structuredContent: result as Record<string, unknown>,
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "Gossip v2 operation failed. Check the local connection and access status.",
          },
        ],
      };
    }
  }

  server.registerTool(
    "gossip_capabilities",
    {
      description: "Discover the exact Gossip v2 capabilities of the engine.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => invoke(() => kit.capabilities()),
  );
  server.registerTool(
    "gossip_consult_v2",
    {
      description: "Run an owner-scoped Gossip v2 consultation.",
      inputSchema: { request: consultationSchema },
    },
    (args) => invoke(() => kit.consult(args.request)),
  );
  server.registerTool(
    "gossip_submit_v2",
    {
      description: "Submit one public Gossip v2 evidence graph.",
      inputSchema: { request: publicSubmissionSchema },
    },
    (args) => invoke(() => kit.submit(args.request)),
  );
  server.registerTool(
    "gossip_operation",
    {
      description: "Read one owner-scoped Gossip v2 operation.",
      inputSchema: { operation_id: operationIdV2Schema },
      annotations: { readOnlyHint: true },
    },
    (args) => invoke(() => kit.operation(args.operation_id)),
  );
  server.registerTool(
    "gossip_receipt_v2",
    {
      description: "Read one Gossip v2 operation's signed receipt chain.",
      inputSchema: { operation_id: operationIdV2Schema },
      annotations: { readOnlyHint: true },
    },
    (args) => invoke(() => kit.receipt(args.operation_id)),
  );
  server.registerTool(
    "gossip_feedback",
    {
      description: "Gossip v2 feedback is currently unavailable.",
      inputSchema: { request: z.record(z.string(), z.unknown()).optional() },
    },
    (args) => invoke(() => kit.feedback(args.request)),
  );
  return server;
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GossipKit as RuntimeKit } from "./kit.js";
import { WalletVault } from "./wallet.js";
import { createCredentialStore } from "./credential-store.js";
import { loadConfiguration } from "./configuration.js";
import { connectEngine } from "./engine.js";
import { connectV2Engine } from "./engine.js";
import { GossipV2Kit } from "./kit-v2.js";

async function openKit(directory: string) {
  const configuration = await loadConfiguration(directory);
  const vault = new WalletVault(directory, createCredentialStore(directory));
  const signer = await vault.signer();
  if (configuration.profile === "gossip-eip191-v2") {
    const engine = await connectV2Engine(signer, configuration);
    try {
      const kit = new GossipV2Kit(
        directory,
        signer.address,
        engine,
        configuration,
      );
      return { kit, engine, configuration };
    } catch (error) {
      await engine.close();
      throw error;
    }
  }

  const engine = await connectEngine(signer, configuration);
  try {
    const kit = new RuntimeKit(
      directory,
      signer.address,
      engine,
      configuration.policy,
    );
    return { kit, engine, configuration };
  } catch (error) {
    await engine.close();
    throw error;
  }
}

export async function checkConnection(directory: string): Promise<unknown> {
  const { kit, engine } = await openKit(directory);
  try {
    return await kit.access();
  } finally {
    kit.close();
    await engine.close();
  }
}

export async function serve(directory: string): Promise<void> {
  const { kit, engine, configuration } = await openKit(directory);
  if (!configuration.enabled) {
    kit.close();
    await engine.close();
    throw new Error("Gossip is disconnected.");
  }
  let closed = false;
  const beforeCall = async () => {
    const current = await loadConfiguration(directory);
    if (
      !current.enabled ||
      JSON.stringify(current) !== JSON.stringify(configuration)
    ) {
      throw new Error(
        "Gossip is disconnected or its configuration changed. Restart the bridge.",
      );
    }
  };
  const server =
    configuration.profile === "gossip-eip191-v2"
      ? createV2Bridge(kit as GossipV2Kit, beforeCall)
      : createBridge(kit as RuntimeKit, beforeCall);
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(watch);
    kit.close();
    await engine.close();
    await server.close();
  };
  const watch = setInterval(() => {
    void loadConfiguration(directory)
      .then((current) => {
        if (
          !current.enabled ||
          JSON.stringify(current) !== JSON.stringify(configuration)
        )
          return close();
      })
      .catch(close);
  }, 1000);
  watch.unref();
  server.server.onclose = () => {
    void close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
}
