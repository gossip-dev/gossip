# WS1: executable Gossip v2 contract foundation

Part of epic #3.

## Problem and result

The v1 kit fingerprints JavaScript objects locally, but has no portable byte
contract or explicit v2 negotiation boundary. Two implementations cannot yet
prove that a request has identical meaning and integrity across their boundary.

Deliver a versioned, bounded canonical encoding, strict consultation and
capability schemas, deterministic errors, and independent golden vectors.
A changed actor, endpoint, quality limit, deadline, or cost must change the
operation digest. Unsupported or incomplete capability reports must fail closed.

The implementation candidate is [ADR 0003](../adr/0003-v2-canonical-contract.md).
This child establishes a locally executable foundation; final schema freeze
requires Sherwood to execute the same vectors and validate the authentication
and evidence/receipt contracts in subsequent slices.

## Scope

- New isolated protocol modules, with no changes to the four v1 tools,
  transport identifiers, signing policy, operation journal, or trading tools.
- Exact protocol/schema/auth/MCP pins and explicit endpoint/audience binding.
- Canonical Ethereum identifiers and uint256 decimal strings.
- A content digest for the entire consultation envelope, domain separated from
  evidence and receipt digests.
- Bounded input decoding that rejects ambiguous JSON before hashing.
- Readiness negotiation that distinguishes installed from verified and retains
  actionable blockers. This pure function does not establish a live connection.
- An independently implemented Python vector verifier and public machine-readable
  fixtures consumed by the TypeScript implementation.
- Packaged contract documentation and fixtures so downstream implementations can
  reproduce the results from the installed artifact.

## Acceptance

1. Canonical outputs and all three digest domains match literal golden vectors
   in both Node and Python; expected values are not recalculated by the tested
   TypeScript implementation.
2. Unicode sorting/preservation, unsafe/fractional numbers, duplicate JSON keys,
   invalid UTF-8, cycles, unsupported object values, and all resource limits have
   observable rejection coverage.
3. Every envelope field is digest bound. Unknown fields and coercions fail;
   `deadline <= now` fails; standard requests can only specify zero cost.
4. Wrong protocol/schema/auth/MCP revision, endpoint/audience mismatch, stale
   discovery, duplicate capabilities, and missing core features fail closed.
5. Optional unavailable features do not enable themselves or prevent an otherwise
   valid core negotiation. Limits never exceed the local profile's ceilings.
6. Errors contain stable codes and fixed messages, without rejected input data.
7. Existing baseline behavior remains covered by the unmodified v1 tests.
8. Typecheck, tests, build, deterministic formatting, Python verification, and
   installed-package vector execution pass on the final integrated state.

## Test boundaries

The canonical-vector and public protocol-function seams come directly from
epic #3's approved acceptance plan. Tests use synthetic addresses and reserved
example domains. No engine connection, user wallet, RPC, funds, host install,
or production deployment is required to exercise this child.

## Subsequent gates

Evidence and signed receipt schemas, actual authentication/replay verification,
Sherwood's atomic reservation and operation database, MCP/HTTP adapter wiring,
session keys, privacy policy, real hosts, and deployment remain on epic #3.
No completion of this child may be presented as a public v2 release.
