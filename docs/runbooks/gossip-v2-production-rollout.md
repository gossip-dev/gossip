# Gossip v2 production rollout

This runbook turns the locally proven Gossip v2 stack into a production
candidate without promoting unverified capabilities. It applies to the existing
Railway `Sherwood / production` environment and its `engine` service.

## Known production state

The current known Sherwood production source is `main` at commit
`db968f5010b9491b67190aff749d62f2ad0e7a97`. Railway deployment `6415704531`
completed successfully. `/health` returns HTTP 200, a missing public Smart Money
projection returns HTTP 404 without authentication, and anonymous
`GET /v2/gossip/capabilities` returns HTTP 401 because the v2 route is protected.

These probes do not establish signed production acceptance. Treat every v2
capability, advertised host, and package release as blocked until the steps
below produce a signed acceptance record.

## Release inputs

Record the exact public Gossip source root and the reviewed Sherwood engine
revision before deploying. The release record must bind:

- the merged Gossip and Sherwood commits;
- the Gossip package digest and lockfile digest;
- the Railway deployment ID and immutable image digest;
- protocol `gossip/2-draft.1`, schema `2026-09-09`, authentication
  `gossip-eip191-v2`, and MCP `2025-11-25`;
- the production receipt key ID and its separately published public key;
- the exact Grok Bot, Hermes, OpenClaw, Node, operating-system, and protected
  storage versions used in acceptance.

Do not publish a release from an unmerged feature branch or reuse local
synthetic signing keys. The public repository has no accepted provenance run
yet. Produce and independently verify a new repository-bound attestation under
`gossip-dev/gossip` before promoting an endpoint, package, or host.

Use the checked-in
[`ws7-production-manifest.template.json`](../acceptance/ws7-production-manifest.template.json)
as the release record starting point. Replace null fields only with captured
evidence. A template with blockers or false verification flags is not a release
manifest. Generate the final manifest beside the built artifact: embedding a
package's own commit or digest in tracked package content would change the
artifact and invalidate the embedded values.

Validate both blocked checkpoints and the final release record with:

```text
npm run verify:ws7-manifest -- --manifest <absolute-manifest-path>
```

The final record must contain two non-overlapping 30-minute measurement windows.
Every SLO result references both windows, at least 50 observations from each,
their content-addressed summaries, and the exact release, deployment, trust, and
contract revisions. The verifier rejects a `passed` result when any reference,
host, production check, SLO, policy decision, or verification field is missing.
Every passed production check and verified host cites a content-addressed evidence
bundle. A host bundle must contain the commands, versions, exit codes, redacted
diagnostics, install/configured/connected/verified state transitions, wallet path,
restart and lifecycle journeys, and prohibited-data scan required by issue #18.
It validates the record's structure, cross-references, key/address binding, and
chronology. The independent verifier must still fetch the cited artifacts,
recompute their digests and SLO summaries, verify provenance and receipts, and
repeat the required host and production checks; structural validation alone is
not release evidence.

Obtain an explicit product-owner decision on the proposed
[production acceptance policy](../proposals/gossip-v2-production-acceptance-policy.md)
before measuring or filling any SLO or private-policy field.

## Candidate endpoint configuration

The canonical candidate values for the existing Railway domain are:

```text
Sherwood__AgentAccess__Enabled=true
Sherwood__AgentAccess__LegacySubmissionEnabled=false
Sherwood__GossipV2__Endpoint=https://engine-production-c4d8.up.railway.app/mcp
Sherwood__GossipV2__HttpBaseUrl=https://engine-production-c4d8.up.railway.app/
Sherwood__GossipV2__Audience=https://engine-production-c4d8.up.railway.app/
Sherwood__GossipV2__ServerId=sherwood
Sherwood__GossipV2__ServerRevision=<merged-sherwood-commit>
Sherwood__GossipV2__ReceiptSigningKeyEnvironmentVariable=GOSSIP_RECEIPT_SIGNING_KEY
Sherwood__GossipV2__ReceiptSigningKeyId=<approved-production-key-id>
Sherwood__GossipV2__ConsultationEnabled=true
Sherwood__GossipV2__IdentitySessionEnabled=true
Sherwood__GossipV2__ConsultationAcceptanceVerified=false
Sherwood__GossipV2__IdentitySessionAcceptanceVerified=false
```

The Railway secret variable `GOSSIP_RECEIPT_SIGNING_KEY` must contain exactly one
lowercase 32-byte secp256k1 scalar encoded as 64 hexadecimal characters. The
Sherwood configuration stores only that variable's name. At startup, Sherwood
reads the value, removes it from the process environment, validates it, builds
the receipt signer, and clears its temporary byte buffers. The immutable .NET
string returned by the operating system remains subject to garbage collection,
so this mechanism must not be described as guaranteed in-memory erasure.

Provision the secret through Railway's protected variable interface. Never put
the value in a command transcript, repository file, deployment log, acceptance
artifact, or agent prompt. Publish the matching uncompressed public key,
Ethereum address, key ID, validity interval, and status in a separately reviewed
`gossip.receipt-trust-manifest.v1`. Keep `ReceiptSigningKeyFile` unset because
the engine accepts exactly one external receipt-key source.

Leave `PrivateEvidenceEncryptionKeyFile` and
`PrivateEvidenceEncryptionKeyId` unset. Production private submission remains
blocked pending the separately approved retention, hold, deletion, audit,
rotation, and backup-erasure policy.

Never set either `AcceptanceVerified` flag from deployment success alone. Those
flags may change only after the matching production acceptance evidence passes.

## Deployment gate

Before changing Railway, capture the current deployment ID, source commit,
image digest, domain, replica state, and health result. Deploy the merged
Sherwood `main` commit to the existing `engine` service. Do not recreate or
replace the PostgreSQL service.

The new deployment must be rejected if any of these checks fail:

1. Railway reports a source commit other than the recorded merged commit.
2. The engine has no immutable image digest or healthy running instance.
3. `/health` does not return HTTP 200.
4. An unsigned v2 request is accepted.
5. The capability document names a different endpoint, audience, protocol,
   schema, auth profile, MCP revision, server revision, or receipt key ID.
6. A wrong endpoint, audience, nonce replay, expiry, signature, body, query, or
   authentication downgrade reaches application work.
7. Standard plus zero maximum cost creates a nonzero reservation or charge.
8. Private submission, feedback, generic signing, transaction construction, or
   trading becomes reachable.

## Host acceptance

Use a fresh synthetic identity and a separate existing synthetic wallet on each
advertised host. Install the exact released package without lifecycle scripts,
then run `setup-gossip` against the candidate endpoint and audience. Record
install, configured, connected, and verified as separate states.

Hermes and OpenClaw must use their documented additive MCP configuration paths.
Grok Bot remains blocked until its real public MCP configuration or signing
surface is documented; a terminal-only workaround does not establish host
support. On Linux, protected storage must pass in the actual user session rather
than from package presence alone.

Each host must prove:

1. capability negotiation and receipt trust against the pinned production key;
2. one standard zero-cost consultation over the real endpoint;
3. schema-valid evidence and a valid acknowledgment/final receipt chain;
4. exact retry without a second operation, contribution, or charge;
5. changed-content conflict for the same operation ID;
6. owner isolation, restart, upgrade, rollback, disconnect, session rotation,
   revocation, and identity deletion;
7. no key, seed, signature, token, prompt, private claim, or identifying source
   URL in captured output.

## Promotion and rollback

Publish the final WS7 manifest only after two independent clean runs match and
every advertised host passes. Set a capability to `verified` only when its own
evidence cites the production deployment, release artifact, trust manifest, and
host version.

If a deployment or acceptance check fails, restore the previously captured
Railway deployment. Keep the new receipt key ID untrusted, leave both
`AcceptanceVerified` flags false, and record the failed deployment and reason.
Rollback must preserve the PostgreSQL service and all already accepted operation
history.

The epic can close only after the release manifest is independently verified,
the approved numeric latency and reconciliation SLOs are included, and issue
#18 is closed with the complete
production evidence.
