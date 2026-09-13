import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GossipKit } from "../src/kit.js";
import { createBridge } from "../src/bridge.js";

test("the MCP bridge exposes only four Gossip tools and cannot bypass submission policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-mcp-"));
  let calls = 0;
  const kit = new GossipKit(
    directory,
    "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    {
      call: async () => {
        calls++;
        return {};
      },
    },
    { dailyCreditBudget: 0, submissionKinds: [] },
  );
  const server = createBridge(kit);
  const client = new Client({ name: "acceptance", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left);
    await client.connect(right);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      ["agent_access", "agent_consult", "gossip_receipt", "gossip_submit"],
    );
    const result = await client.callTool({
      name: "gossip_submit",
      arguments: {
        submission: {
          schema_version: 1,
          client_id: "test",
          chain_id: 4663,
          subject: "0x0000000000000000000000000000000000000001",
          kind: "token_discovery",
          observed_at: new Date().toISOString(),
          provenance: "observed",
        },
      },
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
