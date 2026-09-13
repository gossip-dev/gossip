# Gossip v2 private-evidence acceptance

This acceptance slice freezes the privacy contract required by issue #16. It
does not activate private submission or claim that Sherwood storage conforms.

## Automated contract checks

Run:

```powershell
npx tsx --test test/privacy-v2.test.ts
npm run verify:privacy-v2
npm run typecheck
```

The checks prove:

- exact coverage of the seven stored data classes and four owner operations;
- canonical request bytes and request digests for all four owner operations;
- strict deletion and correction result schemas with canonical fixture vectors;
- rejection of an incomplete policy and any claim of approved activation;
- root-signed, digest-bound, expiring publication consent;
- one non-enumerating error for all cross-owner operations;
- idempotent deletion plans and minimal tombstones;
- append-only correction lineage;
- deletion results expose a tombstone only for `deleted` and `already_deleted`,
  while `held` has no lifecycle payload; correction results expose only the
  correction digest lineage and an explicit `corrected` or `already_corrected`
  outcome;
- deterministic owner exports without server-only material;
- owner-scoped, time-bounded, deterministically ordered access-audit reads;
- closed, bounded audit and telemetry schemas without owner identifiers;
- independent Python verification of the policy and EIP-191 consent signature.

## Required engine evidence before activation

This slice is insufficient to set `private_submission` to `verified`. The engine
acceptance package must additionally show:

1. encrypted private payload bytes at rest;
2. no plaintext copy in operation, receipt, quarantine, log, trace, diagnostic,
   metric, or covered backup storage;
3. atomic idempotency binding for export, deletion, correction, and audit;
4. crash/restart recovery at each persistence boundary;
5. complete deterministic export for a synthetic owner, including exact export
   and access-audit replay after restart without a second read or successful
   audit side effect;
6. physical removal of eligible bytes with only the approved tombstone left;
7. invariant responses for absent and foreign owner resources;
8. zero prohibited canaries across success and failure paths;
9. unchanged public evidence, v1, operation, receipt, and authentication tests;
10. explicit product and legal approval of a production policy revision.
