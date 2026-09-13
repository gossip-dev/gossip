# Implementation review and evidence

Reviewed the implementation against baseline `30f3ab5` and spec #1, using separate Standards and Spec reviews.

## Standards

Three heuristic findings identified duplicated connection validation, wallet verification, and platform subprocess handling. These are maintainability suggestions rather than demonstrated defects. Platform subprocess behavior remains explicit because Windows DPAPI and Linux Secret Service have different success/missing contracts. No general-purpose process abstraction was added. Readable formatting was applied to newly introduced source.

Independent coordinator review fixed revoked-budget retries, submission/receipt identity validation, removal of user-customized host entries, and installer preservation/cleanup. Linux missing-item handling was checked against the [libsecret implementation](https://github.com/GNOME/libsecret/blob/master/tool/secret-tool.c): exit 1 with no output means no matching item; errors remain failures. Linux runtime evidence remains outstanding.

## Spec

Status now distinguishes kit availability, stored configuration, and unverified storage adapter metadata. CLI failures give sanitized next steps. A configuration-write failure preserves a newly created protected identity for an idempotent retry rather than deleting it. Existing working identities/configuration are not replaced by setup.

The complete spec remains unmet. `docs/acceptance.md` records missing signer/onboarding flows, full diagnostics, and engine/host acceptance dependencies. No release-complete or universal wallet compatibility claim is made.

## Validation

- Main suite: 49 passed, 1 skipped (Windows denied symlink creation), 0 failed.
- TypeScript checking and build passed.
- npm audit: 0 known vulnerabilities at validation time.
- Pinned Sherwood integration: 1 passed; real MCP/authentication/PostgreSQL accepted the kit proof and rejected tampering, replay and wrong audience.
- Installer regression checks passed after cleanup changes, including disabled lifecycle scripts and repeated installation.

All wallets and secrets used for tests were synthetic. The engine harness does not yet exercise the complete installed CLI/domain-call flow.

The bundled tarball also installed offline into an isolated directory with an empty npm cache. Its installed CLI reported configuration pending without creating a wallet, and repeating the install preserved the existing package. This verifies the local artifact path, not a hosted release distribution channel.
