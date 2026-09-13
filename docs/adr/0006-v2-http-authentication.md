# ADR 0006: Executable v2 HTTP authentication profile

## Status

Accepted for the reusable verifier and message builder. Transport wiring is
intentionally deferred. The existing v1 transport remains unchanged.

## Decision

The v2 HTTP proof uses the exact profile identifier `gossip-eip191-v2` and five
distinct headers:

- `X-Gossip-Auth-Profile`
- `X-Gossip-Public-Key`
- `X-Gossip-Signature`
- `X-Gossip-Nonce`
- `X-Gossip-Expires`

The signed EIP-191 personal-sign message is the UTF-8 encoding of these
newline-separated components, in order:

```text
Gossip request v2
gossip/2-draft.1
gossip-eip191-v2
<canonical HTTPS audience>
<canonical HTTPS endpoint>
<uppercase HTTP method>
<exact target path and query>
sha256:<lowercase hex SHA-256 of the raw body bytes>
<lowercase canonical UUID nonce>
<decimal expiration>
```

Every component is non-empty and contains no carriage return or line feed.
The endpoint must equal resolving the exact target against the canonical HTTPS
audience, with no hash, backslash, redirect, or downgrade. The target path and
query are signed exactly as received; network-path targets and cross-origin
resolution are rejected.

The verifier receives a required, separately configured expected `audience` and
`endpoint`. It rejects any request whose signed values differ from those exact
values. Deployments must source both values from operator-pinned configuration
or an independently authenticated service registry. They must never derive
them from `Host`, `Forwarded`, `X-Forwarded-Host`, or similar unvalidated
request headers.

The public key is an uncompressed secp256k1 key. Signatures use the canonical
65-byte Ethereum form with recovery byte 27 or 28 and low-S. The verifier
derives the address from the public key and requires both recovered address and
recovered public key to match.

The raw HTTP body is limited to 65,536 bytes and is hashed byte-for-byte. The
server verifier accepts only a `Uint8Array` body and checks its size before
copying it; decoded text is not a valid verifier input. The message builder may
accept a string convenience value and encodes it as UTF-8 before signing. The
body is not required to be canonical JSON: an outer JSON-RPC/MCP framing layer
may be empty or noncanonical. Canonical validation belongs to the inner
protocol envelope/application layer.

The verifier requires `now < expires <= now + 300` seconds. The nonce is
included in the authentication preimage but deliberately remains outside the
logical body digest. A server must durably record accepted nonce values for the
authenticated identity and reject replay; this module does not provide that
stateful policy.

`gossipV2AuthMessage` constructs and validates the signed preimage,
`gossipV2AuthHeaders` validates proof fields and constructs the exact wire
header names, and `verifyGossipV2HttpRequest` validates the request against its
required trusted verifier configuration and returns the authenticated address,
key, nonce, expiry, body digest, and preimage.

Record-style header input rejects normalized duplicate names and array values.
The platform `Headers` abstraction may coalesce duplicate wire fields before a
program sees them; an HTTP server must reject duplicate raw fields before
constructing `Headers`.

## Consequences

The profile is fail-closed for malformed headers, legacy v1 names, profile
downgrade, path or audience mismatch, body tampering, replay-window violations,
high-S signatures, and unsupported recovery values. No redirect-following or
v1 middleware change is required to use the pure verifier.

UUID nonces are lowercase RFC 4122/9562 variant UUIDs: the version nibble is
`1` through `8`, the variant nibble is `8`, `9`, `a`, or `b`, and all other
hexadecimal characters are lowercase.
