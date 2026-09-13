# ADR 0008: Gossip v2 private-evidence lifecycle

Status: accepted for the draft protocol contract; production activation blocked

Date: 2026-09-10

## Context

Gossip evidence can already declare owner-only access, but that declaration does
not define storage, retention, export, deletion, correction, consent, access
audit, or telemetry behavior. Enabling private submission without those rules
would make deletion unverifiable and could expose private claims through copies,
logs, metrics, public hashes, or identity links.

Exact retention periods and hold rules still require product and legal approval.
The protocol therefore needs a complete test contract without claiming that a
production policy or storage implementation is ready.

## Decision

Freeze `gossip.privacy-policy.v1` with seven exhaustive data classes and four
owner operations. The checked-in policy uses synthetic retention periods and is
permanently marked `blocked_pending_approval`. A future production revision must
be approved explicitly and pass engine conformance before `private_submission`
can be advertised as verified.

The data classes are `private_payload`, `public_envelope`, `operation`,
`receipt`, `quarantine_record`, `access_audit`, and `aggregate_metric`.

The owner operations are export, deletion, append-only correction, and access
audit. Their authenticated owner comes from the transport proof. A body that
names a different owner is unavailable. Missing, foreign, and inaccessible
private resources use the same `privacy_unavailable` error.

Owner deletion removes eligible payload bytes at the engine boundary and leaves
only a private tombstone containing the owner, evidence digest, policy revision,
reason, deletion time, and idempotency operation ID. Accepted operations,
published envelopes, and signed receipts remain integrity records. Holds defer
deletion; they do not make private bytes readable.

Corrections append a new digest to the lifecycle record. They never mutate the
prior evidence or its signed history. Export records are sorted by data class and
record ID and reject server-only key material.

The public deletion result is frozen as `gossip.privacy-deletion-result.v1`.
It includes the protocol, policy revision, owner, operation ID, and explicit
`deleted`, `already_deleted`, or `held` outcome. A tombstone is required for
the first two outcomes and forbidden for `held`; the lifecycle record is never
returned on the wire. The public correction result is frozen as
`gossip.privacy-correction-result.v1` and includes the same operation binding,
an explicit `corrected` or `already_corrected` outcome, and the bounded
append-only `correction_digests` list. Both results use closed schemas and have
canonical fixture vectors. These helpers wrap the lifecycle planning functions
only; they do not register transport tools or activate `private_submission`.

An exact retry of a completed owner operation returns the original outcome and,
for export or access audit, the original response snapshot. It does not read the
owner partition again or append a second successful access-audit event. Engines
must retain that snapshot without creating a plaintext copy of private data.

A public commitment or linkable identity association requires a fresh
`gossip.publication-consent.v1` record signed by the root Gossip Identity Wallet.
The signature uses the existing `identity` canonical digest domain and this
EIP-191 preimage:

```text
Gossip publication consent v1
gossip/2-draft.1
gossip.publication-consent.v1
<consent-digest>
```

Consent binds the owner, evidence digest, policy revision, explicit disclosure
types, issue time, and expiry. It grants information-publication consent only;
it grants no payment, trading, transaction, or arbitrary-signing authority.

Privacy audit and telemetry are separate closed schemas. Audit events contain no
owner address or evidence digest because the storage partition supplies owner
scope. Telemetry permits only fixed event names, coarse statuses and errors,
bounded counts, bounded durations, and a server-issued UUIDv7 correlation ID
valid for at most five minutes. Arbitrary labels and attributes are invalid.

## Engine boundary

The protocol helpers plan lifecycle transitions; they do not prove that private
bytes were erased or encrypted. Sherwood must satisfy all of these conditions
before activation:

1. encrypt private payloads at the engine storage boundary;
2. prevent plaintext copies in operation results, receipts, quarantine rows,
   logs, traces, diagnostics, and backups covered by the active policy;
3. durably bind each owner operation ID to its canonical request digest;
4. make export, deletion, correction, and access-audit writes recoverable and
   idempotent across crash and restart;
5. scan every success and failure path with synthetic canaries;
6. pass owner-isolation and non-enumeration tests through the real transport.

Until those conditions pass, adapters must report `private_submission` as
blocked with an actionable reason.

## Consequences

The repository can independently verify the privacy contract before accepting
private production data. Synthetic retention values make tests exact without
silently deciding product or legal policy. Engine implementations must account
for every copy of private bytes; deleting one table row is insufficient.

The root signature makes publication consent independently auditable. Session
keys do not receive privacy-management or publication-consent authority in this
revision.
