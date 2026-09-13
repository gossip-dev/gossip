# ADR 0007: Scoped v2 identity-session authorization

## Status

Accepted for the portable `gossip/2-draft.1` contract and offline verifier.
Server registration, durable nonce enforcement, protected session-key storage,
transport wiring, and capability verification remain separate activation gates.

## Decision

A Gossip Identity Wallet may authorize a short-lived session key without giving
that key payment, trading, transaction, or generic signing authority. The root
identity stays the operation owner. The session key only proves that a request
was made within an exact information-plane scope.

The canonical grant schema is `gossip.identity-session.v1`. It binds:

- root chain and lowercase EOA address;
- session key ID, uncompressed secp256k1 public key, and derived address;
- exact HTTPS endpoint and audience;
- an ordered, duplicate-free allowlist of Gossip tools;
- an ordered, duplicate-free allowlist of evidence submission kinds;
- an earned-credit ceiling;
- issuance and expiry, with a maximum lifetime of 24 hours; and
- the predecessor key ID and grant digest for rotations.

The finite tool allowlist contains only `gossip_capabilities`,
`gossip_consult_v2`, `gossip_submit_v2`, `gossip_operation`,
`gossip_receipt_v2`, and `gossip_feedback`. Submission and feedback require an
explicit information-kind scope. No schema field can express a payment,
transaction, calldata, allowance, trade, arbitrary signer, or execution right.

The grant digest is:

```text
sha256("gossip/2-draft.1\nidentity\n" || canonical_json(grant))
```

The root EOA signs this exact EIP-191 personal-sign message:

```text
Gossip identity session v1
gossip/2-draft.1
gossip-eip191-identity-session-v1
<grant_digest>
```

The signature is lowercase 65-byte Ethereum hex with recovery byte 27 or 28
and low-S. The verifier requires the supplied root public key, its derived
address, the recovered public key, and the recovered address to agree.

A rotation is a newly signed complete grant. It names the immediately preceding
key ID and grant digest, uses a new key ID, and lists the full replacement
scope. Earlier keys are retired for new authorization. Permissions are never
copied or inferred from the predecessor.

Revocation uses `gossip.identity-session-revocation.v1`, the same identity
digest domain, and a distinct signed message. It binds the root identity, key
ID, exact grant digest, and effective time. Revocation is terminal for new
authorization. It does not modify accepted operations, receipts, or uncertain
reservations. Deleting local key material does not claim remote revocation.

Session requests use the canonical `gossip.identity-session-request.v1`
envelope. Its signed body contains the root identity, key ID, tool, optional
submission kind, earned-credit cost, and the complete tool payload. Tool and
cost arguments are therefore part of the bytes authenticated by the session
key; an adapter cannot relabel a valid signature as a different action.

Authorization first runs the frozen `gossip-eip191-v2` verifier over that raw
body, destination, nonce, expiry, public key, and session signature. It then
parses the exact canonical request envelope. The active grant must match that
authenticated session, the root owner, key ID, endpoint, audience, time
interval, tool, optional submission kind, and cost ceiling. Any mismatch,
retired key, expired key, or effective revocation returns the same
`unauthorized` result to avoid key enumeration. Durable nonce replay storage
remains a mandatory server gate; the portable verifier does not claim that
stateful guarantee.

When a server activates this contract, direct session consultation uses
`POST /v2/gossip/session` and transports the canonical
`gossip.identity-session-request.v1` envelope as its complete body. The HTTP
EIP-191 signature covers those exact bytes. MCP retains the six logical Gossip
tool names; a session call supplies one exclusive `session_request` argument
containing the same envelope, while the signature covers the complete raw MCP
JSON-RPC body. The adapter must authorize the extracted envelope and verify
that its `tool` is the called MCP tool. Standard object-valued `_meta` framing
is ignored; task-augmented calls are outside this activation and rejected.

Root-only management uses `POST /v2/gossip/sessions/grants` and
`POST /v2/gossip/sessions/revocations`; their exact response schemas remain a
server concern. The outer management request uses the `gossip-eip191-v2`
profile over its raw body, contains an inner signed record, and requires the
outer and inner root identities to match. Each grant covers exactly one
endpoint, so `/mcp` and `/v2/gossip/session` require distinct grants and may
use distinct audiences.

The implemented session payload mapping is intentionally narrow:
`gossip_capabilities` receives `{}`, `gossip_consult_v2` receives a bare v2
consultation, and `gossip_operation` and `gossip_receipt_v2` receive
`{operation_id}`. Consultation cost must equal the payload's `max_cost`; the
other three implemented tools require zero cost. `gossip_submit_v2` and
`gossip_feedback` remain reserved and fail closed. A request cannot provide
both the root argument form and `session_request`.

Sherwood activation must bind the root owner on chain `4663`, enforce
`issued_at <= now < expires_at`, cap each root at sixteen grants and the
24-hour grant lifetime, reject globally reused session public keys and
addresses, and linearize authorization at a durable `(root, key_id, nonce)`
insert. Retired or revoked keys cannot authorize new reads or work; the root
owner remains the historical owner of accepted operations and receipts.
These are activation requirements, not a claim that the public kit or a live
Sherwood host implements them.

## Standards boundary

The profile uses EIP-191 for EOA proof, consistent with the frozen v2 HTTP
profile. ERC-1271 remains a separate contract-wallet verification path because
its answer can depend on chain state. Draft execution-delegation standards such
as ERC-7710 are not activated: their authority model concerns account execution,
while Gossip sessions authorize only information-plane requests.

## Consequences

The public kit can validate grants, rotation chains, revocations, and request
scope offline against literal vectors. It still cannot advertise
`session_keys=verified`. A production engine must atomically persist grants,
revocations, owner mappings, and `(owner, key_id, nonce)` replay records before
accepting work. Existing v1 tools and authentication remain unchanged.
