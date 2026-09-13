# Spec 1 acceptance status

This preview is partial implementation, not release acceptance.

## Implemented locally

- Protected EOA creation/reuse and encrypted JSON import/backup with address preservation; Windows DPAPI round trip.
- Linux Secret Service round trip is covered by `.github/workflows/linux-secret-service.yml` on `ubuntu-24.04`. The job creates a private D-Bus session and temporary `gnome-keyring` home, then exercises identity creation, idempotent reuse, protected-key read and removal through `CredentialStore`; it does not run setup or connect.
- Existing-wallet attach-file flow documents the tested source format labels (`raw-hex`, `json-privateKey`, `json-private_key`), checksummed address continuity, source preservation, and link-only deletion. It does not claim a completed Grok host run.
- Four-tool MCP bridge, exact legacy signing, ERC-8128 client profile, strict endpoint binding and no redirects.
- Submission-kind permission and conservative SQLite reservations shared by processes using one state directory.
- Additive host config editing, conflict protection, explicit removal and local disconnect.
- EIP-55 vectors, ERC-8004 metadata/read validation and AgentWalletSet typed-data preparation, actual local ERC-1271 contract fixture.
- Checksum-verified local artifact installer, package build, and isolated process tests.
  A public provenance run has not yet been regenerated under the `gossip-dev`
  repository identity.
- Draft Gossip v2 private-evidence contract with exhaustive synthetic retention,
  owner operations, minimal tombstones, root-signed publication consent, and
  closed observability schemas. Private submission remains blocked until the
  Sherwood and product-policy gates in `docs/acceptance/v2-private-evidence.md`
  pass.
- Content-addressed Gossip v2 acceptance-manifest contract and clean-checkout
  offline runner for the packaged artifact. Engine/process scenarios remain
  blocked as documented in `docs/acceptance/v2-conformance-foundation.md`.

## Required before closing #1

- Public endpoint plus actual version-pinned Grok Bot, Hermes and OpenClaw end-to-end runs. Config-shape tests are not host runs.
- Engine support and actual access interoperability for ERC-8128, existing ERC-1271 accounts and atomic standard-only consultation policy. Engine changes are outside this repository's authorization.
- Connect-existing-signer, external-provider integration, and complete contract-wallet onboarding remain incomplete. The attach-file path is a deliberate source-file link through a local host helper, not external signer support or a plaintext fallback. Profile migration/rollback and paired create/migrate acceptance for all six standards remain required.
- Signed production distribution and external signer and derivation format compatibility matrix. The artifact provenance workflow is documented in [`release-provenance.md`](release-provenance.md), but it does not publish to npm or establish production or host acceptance.
- Full installed-process-to-engine acceptance for domain calls, TLS rejection, expiry boundaries, and retry reconciliation. The current engine harness proves legacy authentication through real middleware/MCP/PostgreSQL, not the full CLI flow.

No production wallet, onchain transaction, registration, endpoint deployment or package publication is part of these checks. No universal Ethereum compliance is claimed.

No public release baseline or attested artifact is currently approved. A fresh
provenance run must bind the public source root, package digest, workflow run,
and acceptance evidence before any production or host-verification claim.
