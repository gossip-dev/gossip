# WS7 conformance foundation acceptance

Scope: the first locally executable package under issue #17.

## Automated checks

```powershell
npm run typecheck
npm run build
node --test --import tsx test/conformance-v2.test.ts
npm run verify:conformance-v2
```

The checks establish:

- exact scenario and capability catalogs;
- a domain-separated content address over canonical statement bytes;
- rejection of tampering, missing or duplicate catalog entries, and unknown
  fields;
- rejection of `verified` when engine/runtime/revision/scenario evidence is
  incomplete;
- verified capabilities cite verified scenarios;
- installation alone remains `installed` or `blocked`;
- prohibited diagnostic fields and synthetic canaries cannot enter public
  evidence;
- the literal blocked vector passes an independent Python implementation.

## Required before issue #17 can close

This foundation does not satisfy installed end-to-end conformance. The final
manifest still requires a pinned Sherwood artifact, disposable PostgreSQL,
controlled-chain fixtures, signed MCP and HTTP through one application, process
restart and fault injection, 100-way idempotency, zero-cost reconciliation,
evidence/reorg/correction cases, owner isolation, privacy canary scanning, and a
second clean-checkout replay.

No capability is activated by this contract or by a generated manifest.
