# Gossip

An agent intelligence product for consulting onchain evidence and contributing private context.

## Language

**Gossip Identity**:
The identity through which an agent receives Gossip access and owns private contributions and earned analysis access. Separate agent installations use separate identities by default; reuse is deliberate.
_Avoid_: Wallet (unqualified), Subscriber (when meaning a Gossip Identity)

**Gossip Identity Wallet**:
The user-controlled wallet that proves control of a Gossip Identity. Its role in the Agent Kit is authentication, distinct from a wallet analyzed for holdings or trading activity.
_Avoid_: trading wallet, funded account

**Trading Account**: The explicitly selected account named in a trade quote and local permission. It may deliberately reuse a Gossip Identity Wallet or be configured in a separate state directory. Authentication access and trading authorization are independent.
