# Host onboarding

The [canonical agent prompts](agent-prompts.md) contain standalone General,
Grok Bot, Hermes, and OpenClaw instructions. They preserve the distinction
between additive configuration, a locally loaded bridge, and actual host
acceptance.

`hostConfiguration(host, command, args)` returns a configuration fragment and
instructions. Its `verified` value is false for every host: documented schema
support is not a live host or engine verification.

`installHost` and `uninstallHost` are the explicit file mutation APIs. They
require an absolute caller-provided path, reject symlinks, preserve existing
YAML comments and servers, make idempotent exact installs, reject conflicting
`gossip` entries, and remove only an exact installed command/args pair.
Writes use a same-directory temporary file and a unique backup for an existing
file. Grok Bot remains outside this file-mutation API because its integration
is an agent-only host tool call.

Hermes receives a YAML-shaped fragment under `mcp_servers`:

```yaml
mcp_servers:
  gossip:
    command: gossip
    args: [serve]
```

OpenClaw receives a JSON-shaped fragment under `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "gossip": { "command": "gossip", "args": ["serve"] }
    }
  }
}
```

The caller must merge either fragment into the existing host configuration.
The function's `verified` flag describes the documented configuration shape;
it does not claim that a particular host installation or engine connection was
tested. Host end-to-end verification remains unavailable in this package.

Grok Bot returns `format: "agent-tool"` with an additive `AddMcpServer` call.
The arguments contain `name: "gossip"`, the actual `process.execPath`, and the
absolute CLI `serve --directory` arguments. The kit never hardcodes a runtime
version path and never invents or edits a Grok Bot settings file.

The host agent must use the emitted arguments only after `gossip connect`
succeeds. It then calls `RestartMcpServers` and, in the next message, checks
`GetMcpServerStatus` plus `GetDynamicTools`. The expected v2 tools are
`gossip_capabilities`, `gossip_consult_v2`, `gossip_submit_v2`,
`gossip_operation`, `gossip_receipt_v2`, and `gossip_feedback`. The generated
payload retains `verified: false`; only an observed connected status and exact
tool discovery can establish `loaded=true`. `host-install` continues to reject
Grok Bot because a terminal process cannot invoke an agent-only host tool.

The v2 transport learns a per-connection clock offset from a timely `Date`
header returned by the exact configured HTTPS endpoint. It accepts a bounded
absolute skew below 300 seconds and refreshes stale server-time evidence during
a long-running bridge. Missing, malformed, slow, redirected, or out-of-range
evidence fails closed. The kit never changes the host system clock and ordinary
`serve --directory ABSOLUTE_STATE` is sufficient; no host-specific wrapper is
required.

The shapes are based on the official Hermes MCP documentation and OpenClaw MCP
reference:

- [Hermes MCP servers](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md)
- [OpenClaw MCP CLI](https://docs.openclaw.ai/cli/mcp)
- [OpenClaw configuration reference](https://github.com/openclaw/openclaw/blob/main/docs/gateway/configuration-reference.md)

## Grok Bot field report

A user-supplied test on commit `def9b41` reported successful source installation and build on Node 20.19.2/npm 9.2.0, but CLI startup failed because Node 20 has no `node:sqlite`. The environment also lacked Secret Service, D-Bus, a configured engine endpoint, and a verified host integration. No wallet was changed and no signed access check ran.

The CLI now loads SQLite-dependent bridge code only for connection/runtime commands. Help, status and doctor can explain the Node 24 prerequisite on Node 20. The Linux bootstrap installs a dedicated Node runtime and optionally the distribution storage packages; a working user keyring session and actual Grok Bot MCP integration remain separate requirements. This field report is not a full host acceptance pass.

A later user-supplied inspection on Grok Bot host revision `5a2fbc2` found the
first-party agent tools `AddMcpServer`, `RestartMcpServers`,
`GetMcpServerStatus`, `GetDynamicTools`, and `UninstallMcpServer`. It also
confirmed that MCP registration is additive and that stdio processes are
started by the host rather than preserved as independent daemons. No Gossip
server was registered during that inspection. The finding establishes the
adapter contract used by `host-config`; it does not establish a successful
Gossip load, exact tool discovery, persistence in a new conversation, or host
acceptance.
