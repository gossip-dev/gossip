# ADR 0009: Gossip v2 conformance evidence

## Status

Accepted for the WS7 candidate. It does not activate a capability or constitute
public host acceptance.

## Context

Gossip and Sherwood have executable v2 contracts and in-process tests, but no
single artifact proves an installed kit, packaged engine, both transports,
durable state, injected failures, and redacted output together. Installed code
must never be treated as verified server support.

The conformance result must be portable and independently checkable. It also
has to represent missing engine evidence honestly while the Sherwood stack and
external release dependencies remain incomplete.

## Decision

Gossip owns the conformance orchestrator and the public acceptance envelope.
Sherwood may expose narrowly scoped fault controls only in a disposable test
profile. There is no production fault endpoint.

The envelope contains a closed `gossip.acceptance-statement.v1` and a SHA-256
content address. The digest input is:

```text
gossip/2-draft.1
conformance
<canonical-statement>
```

The `conformance` digest domain is distinct from requests, evidence, receipts,
and identity continuity. The content address covers the statement only, so it
does not hash itself.

Every manifest enumerates all sixteen scenarios and all nine negotiated
capabilities exactly once. A verified capability cites verified scenarios.
`installed`, `blocked`, and `not_applicable` entries contain a fixed reason and
one actionable next step. Installation cannot satisfy a verified capability.

The runner may receive an absolute clean local Sherwood checkout plus a
40-character lowercase commit. It accepts only a canonical `gossip-dev/sherwood`
HTTPS or SSH origin, rejects a reparse-point root or dirty source, clones
without hardlinks, and verifies a clean detached checkout at that exact
commit. This is an explicit source-execution trust boundary for the caller.
The process slice records a strict Sherwood assembly digest and size separately
from an optional production image digest. A source run may have an assembly
without an image; an overall `verified` decision still requires the production
image gate.

The process slice runs the pinned external-process tests in one bounded TRX,
with bounded stdout and stderr captures. Public evidence contains only hashes,
sizes, exact test FQNs and counters, measured runtimes, pinned revisions and
boolean results. Restricted raw captures are scanned and deleted with the
disposable checkout. A passing slice may mark `mcp_http_parity`,
`privacy_canary_scan`, `operation_exactly_once`, `operation_conflict`,
`authentication_fail_closed`, `session_scope_escape`,
`public_submission_transport`, `zero_cost_reconciliation`,
`persistence_fault_recovery`, and
`owner_isolation` verified, and only when the manifest also
contains the pinned Sherwood commit and assembly, measured
.NET/Docker/PostgreSQL versions, and engine/migration revisions. It does not
promote capabilities or imply production privacy approval, TLS, image
provenance, protected client session-key storage, or host acceptance.

An overall `verified` decision requires:

- exact Gossip and Sherwood artifact identities;
- engine, database, Docker, .NET, and PostgreSQL revisions;
- every scenario to be verified;
- the four core capabilities to cite verified evidence.

The manifest reports evidence; the server does not consume it as a readiness
switch. Activation remains an operator-controlled configuration decision with
its own trust and deployment controls.

Public evidence files contain summaries and digests. Raw signed requests,
receipts, signatures, and private canaries remain in restricted disposable
capture storage. The publication scanner rejects credentials, keys, signatures,
prompts, source URLs, token fields, and caller-supplied canaries before a public
artifact is written.

A clean-checkout replay reproduces the scenario decisions and capability map
for the same pinned inputs. Generated timestamps and environment-specific
artifact bytes do not need to be byte-identical.

## Initial implementation

`scripts/run-v2-conformance.mjs` proves the first local slice from a clean
checkout: build, package, SHA-256 verification, installation through the public
installer, installed CLI execution, and all independent protocol verifiers. It
emits a content-addressed blocked manifest. Engine, MCP/HTTP, fault, privacy,
and replay scenarios stay blocked until their process-level evidence exists.

The first Sherwood fault profile must freeze these cut points before use:

1. after durable operation binding;
2. after economic reservation;
3. after the execution claim;
4. before and after evidence persistence;
5. before and after receipt persistence;
6. before terminal settlement;
7. during authoritative reconciliation;
8. during retained-source dependency outage.

Each control is test-profile-only, one-shot, named by the harness, and recorded
in restricted evidence. It cannot accept arbitrary commands, SQL, paths, or
payloads.

## Consequences

The repository can now publish a machine-verifiable blocked result instead of a
prose claim. A later Sherwood harness can fill the same contract without
changing how consumers verify it. The public release remains blocked until the
engine and clean-replay scenarios pass.
