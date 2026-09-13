# Gossip v2 production acceptance policy

Status: retained for public maintainer review. These values are proposed
production-acceptance criteria; they are unmeasured and are not release claims.

## Release decision

The first public Gossip v2 release accepts public evidence only. Private
submission remains disabled and is reported as `blocked`, with no private payload
accepted, retained, exported, or included in telemetry. Enabling private evidence
later requires a separate approved policy for retention, legal hold, deletion,
access audit, key rotation, backup erasure, and incident response.

Public submission still requires explicit approval of the exact content and a
warning before publishing a linkable identity, source, or content commitment.
Feedback remains disabled until its scoped authorization and server capability
pass separate acceptance.

## Proposed service objectives

Request latency is measured at the public HTTPS boundary from complete request
receipt to complete response. Event latency is measured between the named persisted
events in each objective. Deterministic policy refusals are counted separately from
availability failures and must never be removed from reports.

| Signal                            | Proposed objective                                                                                                                                            | Denominator                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Signed capability discovery       | p95 at most 1 s; p99 at most 2 s                                                                                                                              | Every schema-valid, correctly signed `gossip_capabilities` request                                                                        |
| Durable acceptance acknowledgment | p95 at most 1 s; p99 at most 2 s                                                                                                                              | Every operation accepted after authentication, schema validation, authorization, digest and operation-ID binding, and durable persistence |
| Standard zero-cost consultation   | p95 at most 5 s; p99 at most 15 s; availability at least 99%                                                                                                  | Every authorized standard request with zero maximum cost, excluding deterministic contract refusals                                       |
| Pending operation age             | p95 below 30 s; no accepted operation older than 5 min without a terminal or reconciliation state                                                             | Every accepted nonterminal operation sampled once per 10 s interval                                                                       |
| Reconciliation                    | p95 terminal within 60 s; every operation terminal within 5 min                                                                                               | Every operation entering `reconciliation_required` in controlled acceptance                                                               |
| Authentication replay rejection   | 100%                                                                                                                                                          | Every intentionally replayed nonce/signature pair                                                                                         |
| Exact operation retry             | 100% returns the existing operation without another economic effect                                                                                           | Every same-ID, same-digest retry                                                                                                          |
| Changed-content conflict          | 100% deterministic conflict                                                                                                                                   | Every same-ID, different-digest retry                                                                                                     |
| RPC divergence safety             | 100% preserves `conflicts_with` references and an explicit unmet requirement; unresolved conflicting evidence is never returned as independently reproducible | Every injected or observed source disagreement                                                                                            |
| Reorg quarantine                  | p95 within 60 s; p99 within 180 s from engine observation to persisted digest-linked invalidation or quarantine visible through operation or evidence lookup  | Every accepted evidence item affected by a controlled reorg                                                                               |
| Correction publication            | p95 within 5 min from durable correction acceptance to a persisted new evidence digest with visible `supersedes` or correction linkage                        | Every accepted correction that supersedes public evidence                                                                                 |

No percentile is reported with fewer than 100 eligible observations across the two
windows, with at least 50 in each window. Report the sample count, time window,
client region, server revision, deployment ID, and excluded deterministic refusal
count beside every result. Bind each window to the exact Gossip artifact, Sherwood
revision, receipt trust manifest, protocol, schema, authentication, and MCP
revisions, and content-address its result summary.

Consultation availability counts a schema-valid authenticated 2xx response with a
complete result, or a protocol-allowed partial result carrying an authentic receipt,
before the 20-second client deadline. A timeout, transport or TLS error, 5xx,
schema-invalid response, or missing or invalid required receipt is a failure.
Deterministic authentication, authorization, policy, and contract refusals are
reported separately and excluded from this availability denominator.

## Promotion measurement

Run two independent 30-minute windows against the exact candidate deployment and
attested package. Each window must include at least:

- 200 signed capability discoveries;
- 100 standard zero-cost consultations across at least 10 synthetic identities;
- 100 exact retries and 100 changed-content conflicts;
- 50 controlled reconciliation cases spanning restart and persistence cut points;
- 20 owner-isolation attempts;
- 50 controlled source-divergence cases;
- 50 controlled reorg cases;
- 50 accepted corrections that supersede visible evidence;
- 100 intentionally replayed nonce/signature pairs; and
- one restart, session rotation, revocation, upgrade, and rollback journey per
  advertised host.

The release fails if either window misses an objective, any prohibited secret or
private payload appears in capture, or any result cannot be tied to the exact
package, deployment, trust manifest, protocol, schema, authentication, and MCP
revisions.

## Approval record

No approval record has been created under the public `gossip-dev` repository
identity. A maintainer must approve the final criteria in public history before
they become active. Approval alone will not assert that an objective passed,
enable private submissions, or set a production acceptance flag.
