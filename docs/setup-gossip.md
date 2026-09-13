# `setup-gossip` preview workflow

`setup-gossip` is the orchestration entry point for preparing a Gossip agent.
It is a developer preview, not proof that Grok Bot, Hermes, OpenClaw, a public
endpoint, standards interoperability, RPC access, or trading is supported in a
particular environment. The command reports runtime, wallet, host integration,
Gossip connection, RPC, standards, and trading readiness independently.

For copy-paste onboarding instructions with the pinned public endpoint,
audience, v2 profile, wallet branches, host variants, and diagnostic truth,
see [canonical agent prompts](agent-prompts.md). This workflow remains the
normative command reference; prompts do not replace the protocol or
cryptographic specifications.

Use a pinned checkout and an absolute state directory. Source installation is
the default: verify Node.js 24, run `npm ci --ignore-scripts`, and build that
checkout. Use `scripts/install.mjs` only when the exact local `.tgz` and its
independently supplied SHA-256 digest are both available. A digest is not an
artifact locator. Run the checked-in Linux bootstrap only when Node.js 24 is not
already verified; missing `xz` blocks that bootstrap, not an existing verified
runtime. Never execute an unpinned fetched script:

```text
node dist/cli.js setup-gossip --host hermes --directory ABSOLUTE_STATE
```

The host value is one of `grok-bot`, `hermes`, or `openclaw`. Pass
`--config ABSOLUTE_HOST_CONFIG` only for Hermes or OpenClaw file configuration and
`--skills-directory ABSOLUTE_DIRECTORY` to install the `setup-gossip` and
`gossip` skills. Skill installation preserves unrelated files and refuses
conflicts. Grok Bot MCP loading remains unverified; `host-config --host grok-bot`
emits an additive `AddMcpServer` host-tool payload, and a terminal fallback must
be labeled as such.

The v2 transport handles a host clock skew below 300 seconds inside the normal
kit process. It uses only a valid, timely `Date` header from the exact configured
HTTPS endpoint, keeps the offset per connection, and refreshes stale evidence
before later deadline checks. Use the generated ordinary `serve --directory
ABSOLUTE_STATE` command; do not add an external time wrapper. The kit rejects
missing, malformed, slow, redirected, stale, or out-of-range server-time
evidence and never changes the host's system clock. This does not establish
Grok Bot or another host's acceptance.

Wallet selection is performed before endpoint or RPC setup:

```text
node dist/cli.js setup-gossip --host hermes --wallet create --directory ABSOLUTE_STATE
node dist/cli.js setup-gossip --host hermes --wallet reuse --directory ABSOLUTE_STATE
node dist/cli.js setup-gossip --host hermes --wallet attach-file --file ABSOLUTE_FILE --format raw-hex --address CHECKSUM --directory EMPTY_STATE
```

Creating a wallet requires supported protected storage. Reuse preserves the
existing identity. File attachment accepts exactly `raw-hex`, `json-privateKey`,
or `json-private_key`; use the selected value in `--format`. It uses a trusted local host helper and does
not copy a secret into the Gossip profile, Secret Service, model context, logs,
arguments, configuration, or server requests. The source remains owned by the
user, its checksum address is verified, and unsupported external-provider,
recovery-phrase, or contract-wallet APIs stop with a named blocker.

Network setup is explicit and happens after the wallet branch:

```text
node dist/cli.js setup-gossip --host hermes --network configure --rpc https://robinhood-rpc.publicnode.com --directory ABSOLUTE_STATE
node dist/cli.js setup-gossip --host hermes --network check --directory ABSOLUTE_STATE
node dist/cli.js setup-gossip --host hermes --endpoint https://ENGINE/mcp --audience https://ENGINE --directory ABSOLUTE_STATE
```

`--endpoint` and `--audience` attempt signed connection verification.
`setup-gossip` accepts `--profile gossip-eip191-v2` to select the signed v2
engine and six-tool bridge; legacy setup remains the default. It continues to
orchestrate wallet, host, and RPC readiness and
leaves a missing endpoint connection pending. RPC configuration validates
HTTPS, chain 4663, fresh block reads and timeouts; retain a working explicit RPC
and report a failing one before any replacement.

Hermes and OpenClaw require a real documented configuration path and additive
conflict-safe host installation. Grok Bot MCP loading remains unverified; use the
emitted `AddMcpServer` payload only after `gossip connect`, then verify
`RestartMcpServers`, `GetMcpServerStatus`, and `GetDynamicTools`. Use a
documented terminal fallback only when available and label it as such.

For RPC readiness, retain a working configured provider after validating HTTPS,
chain ID 4663, fresh block reads, timeout behavior, and sanitized credentials.
With no configured provider, test `https://robinhood-rpc.publicnode.com`; its
availability is not guaranteed. RPC readiness is independent of legacy Gossip
identity setup. Gossip connection requires the actual HTTPS endpoint and
audience plus a successful signed `agent_access` response; no localhost example
is a deployed service.

Report each standard independently. Installing a client library is not verifier
or engine interoperability. Trading stays disabled unless a verified DEX and
bounded, explicitly authorized wallet policy pass balance, quote, simulation,
allowance, gas, and signing checks. Setup must not fund, approve, broadcast,
register, or broaden permissions.

The local trading preview is explicit and single-trade scoped:

```text
node dist/cli.js trade quote --address WALLET --token-in TOKEN --token-out TOKEN --amount-in BASE_UNITS --fee 3000 --slippage-bps 100 --deadline-seconds 300 --directory ABSOLUTE_STATE
node dist/cli.js trade authorize --quote /absolute/quote.json --id STABLE_ID --gas-limit MAX --max-fee-wei MAX --directory ABSOLUTE_STATE
node dist/cli.js trade execute --id STABLE_ID --directory ABSOLUTE_STATE
node dist/cli.js trade revoke --directory ABSOLUTE_STATE
```

Quotes output unsigned JSON. Authorization requires an interactive terminal
`CONFIRM`, is for one trade, and is never standing autonomous permission. Local
managed EOAs and explicitly attached local-file keys are read only inside
trusted local code; Gossip does not custody them. Exact-amount approval is
allowed only when current allowance is zero; nonzero insufficient allowance is
blocked. The execution journal preserves retry identity and reports pending
transactions without creating a new trade. No live DEX swap has been tested;
only official deployment addresses and synthetic local contracts are evidence.

`trade order create|list|status|check|cancel` maintains a durable local intent
book. It does not install an onchain limit-order protocol or grant standing
authority. A successful check only returns a fresh quote and marks the intent
ready; the existing interactive `authorize` and explicit `execute` commands
remain mandatory. See [`local-order-book.md`](local-order-book.md).

The final report must include evidence, the public wallet address only, and one
concrete next action for every pending facet. Installation never equals a
connected or trading-ready agent.
