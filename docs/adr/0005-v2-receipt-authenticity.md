# ADR 0005: Portable v2 receipt authenticity

## Status

Accepted for the `gossip/2-draft.1` candidate. This decision defines an
offline verifier and an operator-pinned trust-manifest contract. It does not
add a server signer, a secret provider, discovery, an MCP tool, or a
capability claim.

## Decision

Receipt authenticity uses the separate profile
`gossip-eip191-receipt-v1`. A verifier first runs `parseSignedReceipt`, which
continues to provide structural and digest validation, and then verifies the
signature against a caller-supplied trust manifest. No key is learned from a
receipt or accepted through trust on first use.

The manifest is canonical JSON with exactly this shape:

```json
{
  "schema": "gossip.receipt-trust-manifest.v1",
  "server_id": "sherwood",
  "profile": "gossip-eip191-receipt-v1",
  "keys": [
    {
      "key_id": "receipt-key-1",
      "public_key": "0x04...",
      "address": "0x...",
      "valid_from": 1799990000,
      "valid_until": 1800003600,
      "status": "active"
    }
  ]
}
```

The public key is an uncompressed secp256k1 key, and the address must be its
lowercase Ethereum address. Key validity is the half-open interval
`[valid_from, valid_until)`, evaluated against the receipt's `issued_at`.
`active` and `retired` keys can verify receipts in their retained interval;
`revoked` keys cannot. A retired key therefore remains usable for an existing
chain whose receipts were issued before retirement, while a new key can be
used for new operations. Enforcing a stronger new-operations-only rule for a
retired key requires a signed rotation timestamp or operation registry, which
is outside this portable verifier.

The exact UTF-8 EIP-191 personal-sign message is:

```text
Gossip receipt v1
gossip/2-draft.1
<receipt_digest>
```

The signature is canonical unpadded base64url containing exactly 65 bytes in
`r || s || v` order. `v` is exactly 27 or 28, `r` and `s` are valid nonzero
secp256k1 scalars, and `s` must be at most half the curve order. The recovered
public key and address must both equal the manifest entry. The receipt's
server ID, signing profile, and key ID must equal the pinned manifest values.

`verifyReceiptTransitionChainAuthenticity` verifies the structural transition
chain and requires every receipt to use the key pinned by the sequence-zero
acknowledgment. Rotation is represented by a new operation chain and a new
active key; changing keys mid-chain is rejected. Old chains remain verifiable
while their retired key remains in the manifest and within the retention
interval.

## Consequences

Consumers can verify receipt origin without a network call or mutable
discovery response. The existing parser remains useful for structural-only
consumers and does not begin making an authenticity claim. Trust-manifest
distribution, private-key loading, receipt retention, signer persistence,
transactional operation state, and production key approval remain server and
release gates.
