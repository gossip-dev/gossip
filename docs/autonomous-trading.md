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

An active ERC-20 policy can execute a fixed or balance-percentage quick buy.
The stable ID is also the recovery key after an approval, dropped response or
pending transaction:

```sh
gossip trade buy --id buy-0001 --token-out 0xTOKEN \
  --spend-wei 1000000 --directory /absolute/state

gossip trade buy --id buy-0002 --token-out 0xTOKEN \
  --spend-bps 1000 --directory /absolute/state
```

`--spend-bps 1000` means exactly 10% of the current configured ERC-20 input
balance. It never means native ETH while the native adapter is unavailable.

Watcher and DCA commands currently persist lifecycle definitions only:

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
Creating these definitions does not start a worker or grant execution.

## Delivery gates

The repository currently implements policy proposal, activation, status,
revocation, strict matching, conservative reservations, bounded ERC-20 quick
buys, and durable watcher/DCA definitions. Quick buys use the existing
transaction journal and revalidate their active parent policy before signing or
broadcast. Watcher and DCA definitions do not execute yet.

The remaining gates are:

1. Quote evaluation and execution ticks for durable watcher/DCA occurrences.
2. A verified Robinhood WETH9/native-input adapter for examples using ETH.
3. Foreground worker and real Grok Bot, Hermes and OpenClaw acceptance runs.

Do not describe the kit as fully autonomous until all three gates have evidence.
