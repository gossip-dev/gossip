# Autonomous trading delivery contract

Gossip is moving from one-off local trade permissions to a bounded automation
layer. “Autonomous” means the agent can continue inside a policy the wallet
owner approved. It does not mean unlimited discretion.

## Mode selection

Inspect the state before accepting a trading request:

```sh
gossip trade autonomy status --directory /absolute/state
```

When the result is `choice-required`, ask the owner to choose:

1. `confirm-each`: every transaction keeps the interactive one-trade approval.
2. `bounded-auto`: explicit in-bounds buys may run without a second prompt after
   a complete policy is activated locally.

Record the conservative mode with:

```sh
gossip trade autonomy choose --mode confirm-each --directory /absolute/state
```

For bounded mode, first create a proposal. Repeat `--token-out`, `--allow` and
`--fee` to build explicit allowlists:

```sh
gossip trade autonomy propose \
  --id daily-buys \
  --token-in 0xINPUT_TOKEN \
  --token-out 0xALLOWED_OUTPUT \
  --allow quick-buy \
  --allow watcher \
  --allow dca \
  --max-input-per-trade 1000000 \
  --max-input-per-utc-day 5000000 \
  --max-input-total 25000000 \
  --max-trades-per-utc-day 5 \
  --max-executions 25 \
  --max-input-balance-bps 1000 \
  --max-slippage-bps 100 \
  --gas-limit 500000 \
  --max-fee-wei 10000000000 \
  --max-priority-fee-wei 1000000000 \
  --max-gas-cost-per-trade 10000000000000000 \
  --max-gas-cost-per-utc-day 50000000000000000 \
  --max-deadline-seconds 300 \
  --min-native-reserve-wei 1000000000000000 \
  --fee 3000 \
  --valid-until 2000000000 \
  --directory /absolute/state
```

This proposal grants nothing. Review its complete JSON locally, then activate it
from an interactive terminal:

```sh
gossip trade autonomy activate --id daily-buys --directory /absolute/state
```

Stop new autonomous work immediately with:

```sh
gossip trade autonomy revoke --directory /absolute/state
```

For a native-input policy, replace `--token-in 0xINPUT_TOKEN` in the proposal
above with `--input-kind native`. The kit pins Robinhood WETH9 as the pool input
route; the wallet still spends native ETH.

An active ERC-20 or native policy can execute a fixed or balance-percentage
quick buy.
The stable ID is also the recovery key after an approval, dropped response or
pending transaction:

```sh
gossip trade buy --id buy-0001 --token-out 0xTOKEN \
  --spend-wei 1000000 --directory /absolute/state

gossip trade buy --id buy-0002 --token-out 0xTOKEN \
  --spend-bps 1000 --directory /absolute/state
```

`--spend-bps 1000` means exactly 10% of the configured input balance. Under a
native policy this is 10% of the current ETH balance. The kit never silently
reduces that amount: the request fails if it cannot also preserve the approved
native reserve and worst-case gas budget.

Watcher and DCA commands persist durable lifecycle definitions:

```sh
gossip trade watcher create --id watch-1 --token-in 0xINPUT \
  --token-out 0xOUTPUT --comparison at-or-above --amount-out 1000000 \
  --interval-seconds 60 --slippage-bps 100 --directory /absolute/state

gossip trade dca create --id dca-1 --token-in 0xINPUT \
  --token-out 0xOUTPUT --amount-in 1000000 --anchor-at 1900000000 \
  --interval-seconds 3600 --max-runs 24 --slippage-bps 100 \
  --directory /absolute/state
```

Use `list`, `status`, `pause`, `resume`, and `cancel` under either command.
Use `--input-kind native` and omit `--token-in` for native-input strategies.
Creating a definition does not grant authority. Run one deterministic pass or
start the singleton foreground loop with:

```sh
gossip trade automation tick --directory /absolute/state
gossip trade automation run --interval-seconds 30 --directory /absolute/state
```

The loop stops cleanly on SIGINT/SIGTERM and owns `trade-worker.lock`. It never
removes a stale lock automatically; inspect the recorded process before doing
that. Use an OS or host supervisor if the loop must survive logout or restart.

In `confirm-each`, a triggered occurrence returns `awaiting-confirmation` and
an exact quote. Save that quote, authorize its exact occurrence ID through the
interactive `trade authorize` command, then run the same tick again. In
`bounded-auto`, a matching strategy executes without another prompt under its
exact policy revision. Pending retries reuse the same occurrence ID and signed
bytes. DCA skips missed intervals instead of creating a burst.

## Delivery gates

The repository implements policy proposal, activation, status, revocation,
strict matching, conservative reservations, bounded ERC-20 and native quick
buys, deterministic watcher/DCA ticks, and a singleton foreground worker. Every
execution uses the existing transaction journal and revalidates its active
parent policy before signing or broadcast.

Production acceptance still requires:

1. Real funded fork or mainnet acceptance for the pinned Robinhood pools chosen
   by the owner, without granting broader token authority.
2. Supervisor-specific restart acceptance for Grok Bot, Hermes and OpenClaw.
3. An explicit confirmation-depth policy before claiming final settlement.

Local controlled-chain tests establish the execution logic; they do not claim a
production trade or continuous host liveness.
