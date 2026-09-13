# Spec #2 implementation evidence

Developer preview, validated on Windows with Node 24.13.1. This is an
implementation increment, not completed acceptance of issue #2 or a release.

## Checks performed

- TypeScript typecheck and compiled build passed.
- Full public-process suite: 74 tests, 72 passed, 2 platform-specific skips.
- Subsequently added a concurrent RPC-configuration regression: it failed
  before the exclusive configuration lock and passed afterward. The focused
  network suite then passed all 4 tests, followed by typecheck and build.
- A missing-wallet readiness regression was reproduced and fixed so EIP-55
  and EIP-191 each request wallet selection instead of an unrelated HTTP
  profile. All 9 onboarding tests, typecheck and build passed afterward.
- The real engine harness passed its integration test using the pinned
  verifier revision documented in `engine-testing.md`, with synthetic keys.
- Source review covered policy-bound calldata, gas bounds, broadcast recovery,
  revocation and standards claims. Review findings prompted fixes for identical
  transaction rebroadcast, priority-fee bounds and reconciliation after revocation.

The onboarding tests exercise wallet attachment without a desktop keyring,
address-preserving reuse, rejected partial endpoint configuration, additive
host configuration, idempotent skill installation and independent RPC failure.
The HTTPS RPC fixture covers chain mismatch, stale blocks, malformed responses,
redirect rejection, credential-safe output and preservation of configuration.

The controlled Anvil test executes a quote, exact approval and swap using
synthetic ERC-20 and DEX contracts at the configured deployment addresses. It
checks expired quotes, excessive gas, changed calldata, disabled permission,
revocation, dropped broadcast and repeated operation IDs. The dropped request
is retried from persisted signed bytes and does not duplicate the swap.
This fixture is not a real Uniswap fork. Tests do not use user keys or funds.

## Remaining acceptance gates

- Actual version-pinned Grok Bot, Hermes and OpenClaw installation runs.
- A deployed engine endpoint and the inherited standards/provider acceptance
  from #1. Local EIP-55/EIP-191 proof does not establish all six standards.
- Real Uniswap deployment/fork behavior beyond the synthetic fixture. Official
  addresses and runtime code-presence checks establish a narrower guarantee.
- Interactive authorization positive-path automation and comprehensive
  concurrency, nonce-conflict, replacement and reorg scenarios. Current retries
  preserve the same raw transaction; there is no automatic fee replacement or
  external nonce recovery. An unresolved operation requires reconciliation.
- Packaged release provenance and real Linux protected-storage acceptance.

Only per-trade authorization is implemented. Setup does not grant it. Accounts
shared by independent state directories require external coordination. Keep
issue #2 open until its remaining acceptance gates have evidence.
