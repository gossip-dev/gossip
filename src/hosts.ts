export type SupportedHost = "hermes" | "openclaw" | "grok-bot";

export interface HostConfiguration {
  format: "json" | "yaml" | "agent-tool";
  configuration: unknown;
  instructions: string;
  verified: boolean;
}

export function hostConfiguration(
  host: SupportedHost,
  command: string,
  args: string[],
): HostConfiguration {
  assertHost(host);
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("A non-empty host command is required.");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Host command args must be strings.");
  }

  if (host === "hermes") {
    return {
      format: "yaml",
      configuration: { mcp_servers: { gossip: { command, args: [...args] } } },
      instructions:
        "Add this mcp_servers fragment to Hermes configuration without replacing existing servers, then run `hermes mcp status` or reload MCP.",
      verified: false,
    };
  }

  if (host === "openclaw") {
    return {
      format: "json",
      configuration: {
        mcp: { servers: { gossip: { command, args: [...args] } } },
      },
      instructions:
        "Merge this mcp.servers fragment into OpenClaw configuration without replacing existing servers, then run `openclaw mcp doctor` and `openclaw mcp status`.",
      verified: false,
    };
  }

  return {
    format: "agent-tool",
    configuration: {
      tool: "AddMcpServer",
      arguments: { name: "gossip", command, args: [...args] },
      reloadTool: "RestartMcpServers",
      statusTool: "GetMcpServerStatus",
      discoveryTool: "GetDynamicTools",
    },
    instructions:
      "After `gossip connect` succeeds, call Grok Bot's additive AddMcpServer agent tool with the emitted arguments. Then call RestartMcpServers; in the next message, verify GetMcpServerStatus and GetDynamicTools before reporting loaded=true. Do not invent or edit a host configuration file.",
    verified: false,
  };
}

function assertHost(host: string): asserts host is SupportedHost {
  if (host !== "hermes" && host !== "openclaw" && host !== "grok-bot") {
    throw new Error(`Unsupported host: ${host}`);
  }
}
