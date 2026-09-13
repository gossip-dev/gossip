# Gossip v2 private-evidence policy

Revision: `private-evidence-synthetic-2026-09-10`

Status: synthetic conformance policy; production activation blocked

The normative machine-readable vector is `test/fixtures/v2-privacy.json`; its
`result_vectors` freeze the canonical deletion and correction wire responses.
The TypeScript implementation is `src/privacy-v2.ts`, and
`scripts/verify-v2-privacy.py` verifies the policy and root-signed consent
independently.

## Storage classes

These durations are synthetic test values. They are not a production retention
promise.

| Data class          | Clock            | Synthetic retention | Owner export | Deletion behavior               | Hold            |
| ------------------- | ---------------- | ------------------: | ------------ | ------------------------------- | --------------- |
| `private_payload`   | `stored_at`      |             30 days | full         | erase payload, retain tombstone | defers deletion |
| `public_envelope`   | `published_at`   |         365.25 days | metadata     | retain published commitment     | not applicable  |
| `operation`         | `accepted_at`    |         365.25 days | metadata     | retain accepted history         | not applicable  |
| `receipt`           | `issued_at`      |         365.25 days | metadata     | retain signed history           | not applicable  |
| `quarantine_record` | `quarantined_at` |              7 days | metadata     | delete at retention             | defers deletion |
| `access_audit`      | `occurred_at`    |             90 days | metadata     | delete at retention             | defers deletion |
| `aggregate_metric`  | `window_end`     |             30 days | none         | retain aggregation only         | not applicable  |

The policy enumerates every class exactly once. A parser rejects missing,
duplicate, unknown, or additional classes. The same rule applies to export,
delete, correct, and access-audit operations.

## Owner operations

Every privacy request has an operation ID, policy revision, request time, and
explicit action. The transport authenticates the owner. The protocol compares
that identity with the owner bound into the request and returns only
`privacy_unavailable` for a mismatch.

- **Export** returns deterministic, sorted owner records. Server encryption
  keys, token-named fields, storage credentials, and key material are invalid.
  Public asset metadata uses explicit names such as `asset_address` and
  `asset_symbol`.
- **Delete** erases an eligible private payload and keeps the documented minimal
  tombstone. Repeating the same operation returns the existing tombstone.
- **Correct** appends a distinct correction digest and preserves the original
  evidence and supersession history.
- **Access audit** returns only records from the authenticated owner's storage
  partition. Its public event shape contains no owner or evidence identifier.

An active legal or operational hold returns `held` and leaves the payload
unmodified. Hold authorization, approval, and release are engine operations and
must be audited separately.

## Publication consent

Owner-only evidence stays offchain and private by default. Producing a public
hash, changing it to public visibility, or linking it to the owner's identity
requires a root-signed consent record. Consent expires after at most one hour
and names `public_commitment`, `linkable_identity`, or both. Changing the owner,
evidence digest, disclosure list, policy revision, or expiry invalidates the
signature.

## Redacted observability

`gossip.privacy-audit.v1` and `gossip.privacy-telemetry.v1` use closed schemas.
They permit fixed enums, bounded numeric measurements, policy revision, and a
short-lived UUIDv7 correlation ID. They contain no prompt, claim, signature,
token, secret, private key, address, operation ID, evidence digest, or source
URL. Additional fields fail validation instead of being logged.

## Activation gate

Installing or parsing this policy does not enable private submission. A real
Sherwood deployment must prove encrypted owner-scoped storage, durable access
audit, idempotent export/deletion/correction, crash recovery, complete copy
deletion, and zero canary leakage. Product and legal approval must then select a
new production policy revision with explicit durations and hold rules.
