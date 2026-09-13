# Bounded autonomous trading

## Status

Accepted and implemented for local controlled-chain acceptance: policy and mode
selection, bounded signing, native ETH input, watcher/DCA ticks, and a singleton
foreground worker. Production host supervision and funded-chain acceptance
remain separate evidence gates.

## Decision

Gossip supports two trading modes:

- `confirm-each` keeps the existing quote, interactive `CONFIRM`, and execute
  sequence. It creates no standing spending authority.
- `bounded-auto` lets an agent execute an explicit user request without a second
  prompt only after the owner has reviewed and activated a local authorization
  envelope in an interactive terminal.

The envelope binds one wallet and chain 4663 to explicit input and output token
addresses, permitted action kinds, Uniswap fee tiers, input limits per trade and
UTC day, a daily execution count, a balance-percentage ceiling, slippage, gas,
fee and expiry bounds. Missing, malformed, expired, revoked, exhausted or
mismatched authority fails closed. Reservations use stable request IDs;
reusing an ID for different content fails.

Natural-language confidence is never authority. Phrases such as “buy 0.01” or
“buy 10%” must first resolve to an exact asset and integer base-unit amount. The
agent may omit a second confirmation only when that normalized request fits an
active envelope.

Manual `orders.json` entries remain passive. `ready` means that a quote met the
stored condition; it does not authorize execution.

All signing and broadcasting continues through the existing trade executor.
Before every new signature or rebroadcast, autonomous child permissions must
revalidate the active parent policy revision and durable reservation. Signed
bytes are stored before broadcast, and retries reuse the same operation ID,
nonce and bytes.

Watcher and DCA workers use deterministic occurrences. A tick performs one
bounded pass. Missed DCA intervals are skipped by default, and a later
occurrence cannot start while the previous one is unresolved. A foreground
worker requires an external supervisor for unattended liveness.

## Native ETH boundary

Native input is an explicit policy kind. It pins Robinhood WETH9
`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` as the Uniswap pool route and
sends the exact approved ETH amount as SwapRouter02 transaction value. It skips
ERC-20 approval and requires the post-spend balance to retain the configured
native reserve plus worst-case gas. The deployment is recorded by the official
Uniswap contracts inventory and was independently checked through chain 4663
RPC. No other token can be interpreted as native input.

## Consequences

The setup instructions ask the owner to choose a mode when trading is first
requested. Choosing `bounded-auto` is not enough by itself: the owner must also
activate concrete limits. Revocation prevents new signatures and rebroadcasts,
but cannot undo a transaction already broadcast or remove an existing token
allowance.
