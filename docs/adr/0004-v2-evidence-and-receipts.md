# ADR 0004: Gossip v2 evidence and receipt contracts

## Status

Accepted for the `gossip/2-draft.1` candidate. This decision defines portable,
offline contracts only. It does not enable a v2 endpoint, evidence submission,
receipt authenticity, private-data storage, or an intelligence capability.

## Context

Gossip v2 needs to carry claims between agents without turning an installation
into a claim of truth. A consumer must be able to distinguish an observation
from an inference, reproduce declared inputs, evaluate freshness and finality,
follow corrections, and audit an accepted operation without trusting mutable
prose or implementation-specific JSON.

The first v2 slice established strict JSON parsing, canonical bytes, domain
separated digests, consultation requests, and explicit capability negotiation.
This slice extends those primitives while preserving all v1 behavior.

## Decision

### Evidence

An evidence envelope contains a strict `gossip.evidence.v1` payload and its
`canonicalDigest("evidence", payload)`. The payload binds its subject, typed
claim, provenance, observation time, validity interval, immutable source
revisions, replay instructions, confidence components, access scope, derivation
parents, corrections, and conflicts.

Claims use explicit known or unknown values. Decimal values use ordinary signed
decimal notation with at most 78 digits and 18 fractional digits. Exponents,
plus signs, redundant leading or trailing zeroes, and negative zero are invalid.
Confidence is represented as explained reproducibility, corroboration, and
coverage components. The contract has no aggregate truth, profit, prediction,
or trust score.

Chain evidence binds chain ID, block number and hash, optional transaction and
log location, declared finality, declared canonicality, and a validity window.
Source evidence binds an immutable snapshot or issuer interval. Source evidence
does not use chain finality. `observed_at` records retrieval time; freshness is
always measured from the validity window end.

Source references contain an immutable revision and SHA-256 hash of the exact
source bytes. Public locations must be canonical HTTPS URLs. Owner locations use
opaque local references. The parser does not fetch URLs or execute replay
instructions, and URL validation cannot establish that a URL contains no
sensitive information.

### Lineage and access

An evidence graph contains one to sixteen roots and at most 64 envelopes. It
must contain the complete reachable closure and no unrelated envelopes. Digest
lists are sorted and unique. A graph has at most 128 references and a maximum
derivation/correction depth of 16.

Derivation and supersession edges form one acyclic graph. Corrections are
append-only, keep the same subject and access scope, and explain the reason for
supersession. Conflicts remain visible and may be symmetric. Cross-chain
derivation is rejected. Public evidence cannot reference owner evidence through
any link; owner evidence can reference public evidence or evidence belonging to
the same owner.

Topology is checked against declared digest labels before digest consistency so
cycle failures are deterministic. Digest validation then rejects every envelope
whose label differs from its canonical content digest.

### Temporal assessment

Parsing historical evidence never reads the wall clock. A separate pure
assessment accepts an explicit `now`, maximum age, and requested finality. The
effective freshness of a derived root is the oldest validity-window end in its
derivation ancestry. Superseded and conflicting records do not affect that age.

Future facts, expired facts, unknown or invalidated chain canonicality, unknown
finality, and source evidence asked to satisfy chain finality do not satisfy the
declared requirements. Expiry occurs when `now >= expires_at`; age fails only
when it is greater than the maximum. Success means only that the declared
temporal requirements are satisfied. Current canonicality still requires an
engine and RPC verifier. Reorg handling must append digest-linked invalidation
evidence and invalidate descendants when consumed.

### Results and receipts

A `gossip.result.v2` manifest binds a subject to one to sixteen sorted evidence
root digests. Its digest uses the existing evidence domain. When a result packet
is checked, the manifest digests must exactly match the graph roots.

A signed-receipt envelope contains a strict `gossip.receipt.v2` payload, its
`canonicalDigest("receipt", payload)`, and a non-empty canonical unpadded
base64url signature. The receipt binds the request and operation IDs, actor and
owner, endpoint and audience, server and signing identifiers, sequence and
predecessor, acceptance and issue times, requested quality, cost ceiling,
economic state, result digest, and stable error code.

This slice validates signature syntax and receipt integrity only. It does not
choose a signing algorithm, signature preimage, key format, trust anchor, or key
rotation policy. `parseSignedReceipt` therefore returns an unverified envelope;
it is not an authenticity verifier.

The acknowledgment is sequence zero, has no predecessor, and reserves a known
amount before work. State receipts have positive consecutive sequences and bind
their predecessor digest. Pending, complete, partial, rejected, and
reconciliation-required states have explicit result, error, and economic
invariants. Unknown charges stay `null`; they are never converted to zero.
Standard-tier reservations and charges are zero. Reservations cannot exceed the
request ceiling and charges cannot exceed the reservation.

Receipt validation compares the receipt with the independently supplied
consultation. Actor and owner are identical in this candidate. Acceptance must
occur before the request deadline; later state receipts may be issued after it.
An operation may remain pending, enter reconciliation, or become terminal.
Terminal receipts are immutable, apart from exact replay. Server revision may
change during recovery; all other request, identity, connection, signing,
quality, cost, reservation, and acceptance fields stay fixed.

Pre-acceptance failures have no receipt. Reconciliation timing, receipt expiry,
retention, refunds, signer trust, durable persistence, and server lookup remain
future engine and release gates.

## Limits and errors

All objects are strict and use the limits from ADR 0003. Text limits count
Unicode code points. Evidence and packet bounds are checked before hashing.
Parsing does not coerce, trim, normalize case, add defaults, or accept arbitrary
JSON values.

The candidate adds stable non-sensitive errors: `invalid_evidence`,
`invalid_receipt`, `digest_mismatch`, `invalid_lineage`, and `operation_failed`.
Existing canonical, limit, authorization, evidence, freshness, finality, and
reconciliation errors retain their meaning and messages.

## Consequences

Agents can exchange and independently hash bounded evidence and lifecycle
receipts without network access. Consumers can distinguish unknown values from
zero, evaluate declared temporal properties with an explicit clock, and inspect
correction and derivation history. Authenticity, current onchain canonicality,
private evidence operations, persistence, and production capability still need
separate implementations and acceptance evidence.
