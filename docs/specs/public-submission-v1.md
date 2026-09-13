# Public submission contract v1

`gossip.public-submission.v1` freezes the information-only boundary for public
evidence submission. This public kit supplies the portable contract and signed
session request; it does not host an endpoint or persist submissions. Sherwood,
the first engine, separately implements authenticated HTTP and MCP adapters,
durable persistence, exact retrieval, and truthful `installed` capability
reporting behind its process acceptance gate.

The request contains the authenticated v2 actor, endpoint and audience, a
stable operation ID, and an explicit `public_submission` operation kind. Its
`max_cost` is exactly `{ "unit": "earned_credit", "amount": "0" }`. The
top-level contract uses schema revision `2026-09-11`; the embedded frozen v2
evidence and result contracts retain their own `2026-09-09` revision. The request
digest uses the existing `gossip/2-draft.1` `request` domain, so it cannot be
confused with an evidence, receipt, or identity digest.

The result manifest and evidence graph reuse the existing v2 parsers. The
contract additionally requires that every evidence node has public access,
every source location is public, all graph references are closed, and the
manifest roots equal the graph roots in the same order. Owner-private nodes,
links, and sources are rejected before this contract can be used by a
transport.

TypeScript consumers can import `parsePublicSubmission` and
`publicSubmissionDigest` from `dist/public-submission-v1.js`. The literal
vector is `test/fixtures/v2-public-submission.json`; the independent Python
check is run with `npm run verify:public-submission-v2`.

## Signed completion receipt

`gossip.public-submission-receipt.v1` is the contract-only completion receipt
for a public submission. It uses the existing
`gossip-eip191-receipt-v1` signing profile and the existing `receipt` digest
domain. The strict payload contains only the operation binding, actor/owner,
endpoint/audience, server/signing metadata, completion time, result and
evidence digests, and the following zero-cost settlement:

```json
{
  "max_cost": { "unit": "earned_credit", "amount": "0" },
  "economics": {
    "unit": "earned_credit",
    "state": "settled",
    "reserved_amount": "0",
    "charged_amount": "0"
  }
}
```

The signed envelope has exactly `receipt`, `receipt_digest`, and `signature`.
It has no `already_persisted` or other retry marker. A transport may return the
same signed envelope byte-for-byte for the first call and a retry; the receipt
digest therefore remains the idempotency proof. TypeScript consumers can use
`parseSignedPublicSubmissionReceipt` for structural checks and
`verifyPublicSubmissionReceipt` with the existing pinned trust manifest for
EIP-191 authenticity. The literal vector is
`test/fixtures/v2-public-submission-receipt.json`; the independent Python
check is run with `npm run verify:public-submission-receipt-v2`.

Public submissions may point `supersedes` or `conflicts_with` at an external
public evidence digest. Those targets must not be bundled in the same request;
`derived_from` remains closed in the submitted graph. The public parser cannot
prove the visibility or same-subject relationship of an external target, so an
server must resolve it transactionally before accepting the operation.
The general `parseEvidenceGraph` parser remains closed and unchanged by this
mode.

This contract does not activate `private_submission` or `gossip_feedback`.
Trading, payment, generic signing, transaction construction, and blockchain
execution remain outside Gossip's information exchange boundary and remain
blocked here. The `.12` conformance runner requires authenticated persistence,
atomic insertion, retries, correction, conflict, retrieval, and real-process
evidence before it reports the Sherwood adapter as installed. Production TLS,
endpoint, and host acceptance remain separate release gates.
