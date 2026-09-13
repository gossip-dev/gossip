---
name: setup-gossip
description: Prepare Gossip, wallet, host, network, standards, and trading readiness with independent evidence.
---

# Set up Gossip

Use the pinned Gossip checkout and its deterministic CLI. This is a developer
preview workflow; do not claim a host or network capability is ready until its
own check succeeds. Keep these readiness results separate: runtime, wallet,
host integration, Gossip connection, RPC, standards, and trading.

## Start safely

1. Identify the actual host: Grok Bot, Hermes, OpenClaw, or another environment.
   Do not treat ordinary Grok chat as Grok Bot host support. Grok MCP loading is
   still requires a real host check. Grok Bot exposes the agent-only
   `AddMcpServer` path; use the exact payload emitted by `host-config` only
   after `gossip connect`, then verify the host status and dynamic tools.
2. Use the pinned checkout and read its `README.md`, `AGENTS.md`,
   `skills/setup-gossip/SKILL.md`, and `docs/setup-gossip.md`. Build from the
   pinned source by default. Use `scripts/install.mjs` only when the exact local
   `.tgz` and its independently supplied SHA-256 digest are both available.
   Run the checked-in Linux bootstrap only when Node.js 24 is not already
   verified; missing `xz` blocks that bootstrap, not an existing verified
   runtime. Never fetch and execute an unpinned script. Do not replace the
   host's system Node or broaden permissions silently.
3. Run the orchestrator with an absolute state directory:

   ```text
   node dist/cli.js setup-gossip --host hermes --directory ABSOLUTE_STATE
   ```

   Add `--config ABSOLUTE_HOST_CONFIG` for the selected host and
   `--skills-directory ABSOLUTE_DIRECTORY` to install both setup skills while
   preserving unrelated files and refusing conflicts. The accepted hosts are
   `grok-bot`, `hermes`, and `openclaw`; Grok MCP acceptance remains unverified. The
   orchestrator must report each readiness facet independently and give one
   concrete next action for every blocker.

## Choose the wallet before network setup

The wallet branch happens before endpoint or RPC configuration:

```text
node dist/cli.js setup-gossip --host hermes --wallet create --directory ABSOLUTE_STATE
node dist/cli.js setup-gossip --host hermes --wallet reuse --directory ABSOLUTE_STATE
node dist/cli.js setup-gossip --host hermes --wallet attach-file --file ABSOLUTE_FILE --format raw-hex --address CHECKSUM --directory EMPTY_STATE
```

`create` requires supported protected storage. `reuse` must preserve an existing
working identity. `attach-file` accepts exactly `raw-hex`, `json-privateKey`, or
`json-private_key`; use the selected value in `--format`. It uses the trusted
local host helper and the exact selected format; the key must never enter agent context, logs, arguments,
configuration, or a server request. Preserve the source and verify checksum
address continuity. Unsupported provider APIs, recovery phrases, and contract
wallet onboarding are not silently substituted with a new EOA.

## Continue independently

Install only documented host configuration. Hermes and OpenClaw require their
real config path and additive conflict-safe installation. For Grok Bot, run
`host-config --host grok-bot --directory ABSOLUTE_STATE` after a successful
`gossip connect`, pass its emitted `configuration.arguments` unchanged to
`AddMcpServer`, call `RestartMcpServers`, and verify `GetMcpServerStatus` plus
`GetDynamicTools` in the next message. Do not invent a settings file or
hardcode the Node executable path.

For network readiness, validate an explicitly supplied RPC and retain it when
working. If none exists, test `https://robinhood-rpc.publicnode.com` on chain
4663 before reporting RPC ready. RPC failure must not block identity-only
Gossip setup. Pass `--endpoint HTTPS --audience HTTPS --profile
gossip-eip191-v2` to select the signed v2 engine and six-tool bridge. Omitting
`--profile` keeps the legacy Sherwood EIP-191 path. A missing endpoint or
audience leaves connection pending. For network checks, use
`--network configure` with optional `--rpc HTTPS`, or `--network check`;
validate chain 4663 and fresh block reads before reporting RPC readiness.

Check EIP-55, EIP-191, EIP-712, ERC-1271, ERC-8004, and ERC-8128 independently.
Client libraries do not establish verifier or engine support. Trading remains
disabled until a verified DEX, wallet, balance, quote, simulation, policy scope,
and signing path exist. Setup never funds, approves, broadcasts, registers, or
widens permissions.

For the local single-trade preview, `trade quote` accepts `--address`,
`--token-in`, `--token-out`, `--amount-in` in base units, `--fee 3000`,
`--slippage-bps`, and `--deadline-seconds`, and returns unsigned JSON. Use
`trade authorize --quote ABSOLUTE_JSON --id STABLE_ID --gas-limit MAX
--max-fee-wei MAX` only from an interactive terminal after explicit `CONFIRM`,
then `trade execute --id STABLE_ID`; `trade revoke` revokes future local
authorization. This is one trade, never standing autonomous permission. Exact
amount approval is allowed only with zero current allowance; nonzero insufficient
allowance is blocked. The journal keeps retries on the same trade and never
turns pending into a new trade. No live DEX swap is tested; official addresses
and synthetic local contracts are the current evidence.

Agents may keep passive market and limit intents with `trade order
create|list|status|check|cancel`. These records are local, not onchain Uniswap
limit orders. `order check` is a quote-only read and `ready` is not permission.
Every fill must still pass through `trade authorize` with an interactive
`CONFIRM`, followed by `trade execute`. Never start an autonomous order daemon.

The six inherited standards are reported independently: EIP-55, EIP-191,
EIP-712, ERC-1271, ERC-8004, and ERC-8128. A local helper or installed library
does not establish engine or hosted verification; do not report all six as
verified.

Never report “ready” from installation alone. Finish with the evidence for each
facet, the selected wallet address only, and one actionable next step per
pending facet.
