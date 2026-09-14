# Local trading order book

Gossip can persist market and limit buy/sell intents in `orders.json` under the
absolute state directory. The book is local to the agent. It is not an onchain
Uniswap limit-order protocol, a standing trading policy, or an execution daemon.

Create an intent with the trading account already configured in the state
directory:

```sh
gossip trade order create \
  --id limit-buy-1 \
  --side buy \
  --type limit \
  --token-in 0x... \
  --token-out 0x... \
  --amount-in 10000000000000000 \
  --limit-price 1.25 \
  --slippage-bps 100 \
  --deadline-seconds 120 \
  --directory /absolute/state
```

The intent does not need a pool address or fee tier. At check time, the kit
quotes the standard Uniswap V3 tiers and deterministically selects the highest
output. `--fee` preserves an advanced single-tier override, and older stored
orders with a fee continue to use that tier. `amountIn` uses integer token base
units. `limitPrice` is a positive plain-decimal ratio of token-out base
units per token-in base unit, with at most 18 fractional digits. A limit is
reachable only when the fresh quote's `amountOutMinimum / amountIn` is at least
that ratio. This comparison includes the selected slippage bound and uses exact
integer arithmetic.

Inspect and manage the book with:

```sh
gossip trade order list --directory /absolute/state
gossip trade order list --status open --directory /absolute/state
gossip trade order status --directory /absolute/state
gossip trade order check --id limit-buy-1 --directory /absolute/state
gossip trade order cancel --id limit-buy-1 --directory /absolute/state
```

`order check` calls the QuoterV2 route-discovery path. A market order becomes
`ready` after a successful quote. A limit order becomes `ready` when the limit
is reachable and returns the permission-compatible quote as `preparedQuote`.
If a later check no longer meets the limit, the order returns to `open`.
Cancelled orders are terminal. The `filled` and `expired` values are reserved
for a future explicit reconciliation contract and are not inferred in this
version.

`ready` means only that a fresh quote met the local condition. It grants no
permission and does not sign, approve, or broadcast anything. Extract the
returned `preparedQuote` as a quote JSON file, then use the existing guarded
flow:

```sh
gossip trade order check --id limit-buy-1 --directory /absolute/state \
  | jq '.preparedQuote' > /absolute/quote.json
gossip trade authorize --quote /absolute/quote.json --id limit-buy-1 \
  --gas-limit 500000 --max-fee-wei 10000000000 \
  --directory /absolute/state
gossip trade execute --id limit-buy-1 --directory /absolute/state
```

Authorization still requires a real interactive terminal and typing `CONFIRM`.
The order ID does not authorize execution, and checking or cancelling an order
does not modify an existing trade permission or transaction journal.
