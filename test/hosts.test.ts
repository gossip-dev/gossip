import test from "node:test";
import assert from "node:assert/strict";
import { hostConfiguration } from "../src/hosts.js";

test("Hermes returns an additive mcp_servers YAML fragment", () => {
  const result = hostConfiguration("hermes", "gossip", ["serve"]);
  assert.equal(result.format, "yaml");
  assert.equal(result.verified, false);
  assert.deepEqual(result.configuration, {
    mcp_servers: { gossip: { command: "gossip", args: ["serve"] } },
  });
  assert.match(result.instructions, /mcp_servers/);
  assert.match(result.instructions, /merge|add/i);
});

test("OpenClaw uses its documented mcp.servers shape", () => {
  const result = hostConfiguration("openclaw", "gossip", ["serve"]);
  assert.equal(result.format, "json");
  assert.equal(result.verified, false);
  assert.deepEqual(result.configuration, {
    mcp: { servers: { gossip: { command: "gossip", args: ["serve"] } } },
  });
});

test("Grok Bot returns an additive AddMcpServer tool call", () => {
  const result = hostConfiguration("grok-bot", "/opt/gossip/node", [
    "/workspace/gossip/dist/cli.js",
    "serve",
    "--directory",
    "/workspace/state",
  ]);
  assert.equal(result.format, "agent-tool");
  assert.equal(result.verified, false);
  assert.deepEqual(result.configuration, {
    tool: "AddMcpServer",
    arguments: {
      name: "gossip",
      command: "/opt/gossip/node",
      args: [
        "/workspace/gossip/dist/cli.js",
        "serve",
        "--directory",
        "/workspace/state",
      ],
    },
    reloadTool: "RestartMcpServers",
    statusTool: "GetMcpServerStatus",
    discoveryTool: "GetDynamicTools",
  });
  assert.match(result.instructions, /after.*gossip connect/i);
  assert.match(result.instructions, /next message/i);
  assert.doesNotMatch(result.instructions, /mcp_servers|mcp\.servers/);
});

test("invalid hosts and commands are rejected", () => {
  assert.throws(
    () => hostConfiguration("unknown" as never, "gossip", []),
    /host/i,
  );
  assert.throws(() => hostConfiguration("hermes", "", []), /command/i);
  assert.throws(
    () => hostConfiguration("hermes", "gossip", ["--bad", 1 as never]),
    /args/i,
  );
});
