# Gossip v2 evidence and receipt acceptance

Date: 2026-09-09

Protocol: `gossip/2-draft.1`

Tracking: epic #3,
child #6

## Accepted scope

This record covers the portable, offline evidence, result-manifest, and receipt
contracts in ADR 0004. It confirms schema validation, canonical integrity,
bounded lineage, declared temporal assessment, consultation binding, and receipt
lifecycle rules. It does not establish signature authenticity, current chain
canonicality, server persistence, exactly-once economic effects, private evidence
operations, a public endpoint, or host support.

The public v1 MCP and wallet behavior remains unchanged. No v2 MCP tool or
network call was added.

## Verification

The following checks passed from a clean build of the worktree:

- TypeScript type checking and production build.
- 13 focused TypeScript tests for evidence, receipt, and shared literal vectors.
- 13 independently generated Python evidence and receipt vectors.
- Full kit suite: 109 tests, 107 passed, two platform-specific skips, zero
  failures.
- Deterministic Black and Prettier formatting for every changed source and test
  file.
- `npm pack`, installation into a fresh directory with lifecycle scripts
  disabled, imports from the installed `dist/evidence-v2.js` and
  `dist/receipts-v2.js`, graph and receipt parsing, and execution of the packaged
  Python verifier.

The test inputs use synthetic addresses, `.test` URLs, fixed timestamps, and a
signature explicitly labelled synthetic. No key, credential, live RPC, public
endpoint, or production fund was used.

## Independent review findings

The contract review initially rejected the implementation after reproducing
enum coercion, malformed decimal acceptance, incomplete packet limits, raw
JavaScript errors, divergent Python decimal and conflict handling, non-reusable
parser output, weak exported types, and repeated ancestor traversal. Each finding
was corrected and covered by regression checks before this acceptance record.

## Remaining gates

Receipt algorithms, signing preimages, trust anchors, rotation, retention,
reconciliation timing, durable operation storage, authoritative credit
reservation, RPC revalidation, private-evidence lifecycle, and real endpoint and
host acceptance remain subsequent children of epic #3. Until those gates pass,
capability discovery must not advertise these contracts as a verified server
feature.
