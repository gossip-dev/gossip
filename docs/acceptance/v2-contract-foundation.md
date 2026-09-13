# WS1 contract foundation acceptance — 2026-09-09

Scope: Gossip #4, the first local
contract implementation under epic #3.
Baseline: Gossip `bfdbb23`. Contract revision: `gossip/2-draft.1`.

Environment: Windows, Node `24.13.1`, npm `11.8.0`, Python `3.13.5`.
All identities, URLs, timestamps, and chain tests are synthetic or controlled.

## Results

| Boundary                                | Result                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| TypeScript typecheck                    | Passed                                                                               |
| Full kit test suite                     | 96 tests: 94 passed, 2 skipped, 0 failed                                             |
| New v2 contract tests within that suite | 21 passed                                                                            |
| TypeScript build                        | Passed                                                                               |
| Deterministic source formatting         | 6 TypeScript files via Prettier; Python verifier via Black; checks passed            |
| Independent Python vectors              | 17 passed: 5 valid, 12 invalid                                                       |
| Installed Node vector execution         | 17 vectors and 15 literal digests passed                                             |
| Installed consultation boundary         | Full envelope digest matched; expiry and wrong auth profile rejected                 |
| Installed capability boundary           | Core selection passed; wrong MCP revision and missing core rejected                  |
| Frozen v1 source boundary               | Bridge, engine client, transport, v1 schemas, journal, and external signer unchanged |

The two platform skips are the symlink scenario unavailable on this Windows
runner and the Linux-only existing-file permission policy. They are not evidence
of acceptance on Linux or on an agent host. The full suite also retained the
existing controlled contract/chain and Windows DPAPI checks.

## Artifact installation

Built with `npm pack --ignore-scripts`. Artifact:
`gossip-agent-kit-0.1.0-dev.1.tgz`, 14,932,924 bytes, SHA-256:

```text
35be77f8a05a9ca33cce596983c021696ad2e99eb75329592b278f1a7503858a
```

The existing `scripts/install.mjs` attempted the digest-checked local install
but hit its 120-second npm timeout on this runner. A direct npm install of the
same tarball succeeded with `--offline --ignore-scripts --no-audit --no-fund
--omit=dev` in a fresh isolated directory; npm reported approximately three
minutes. No installer timeout, transport, wallet, or credential rule was changed.

After installation, a separate Node process imported the installed modules,
compared canonical bytes and all three digest domains with the shipped fixture,
and tested consultation expiry and negotiation downgrade. The installed Python
script independently verified the same fixture. SHA-256 comparisons confirmed
the installed canonical/protocol/error JavaScript, Python verifier, and fixture
match the built files used for this acceptance run.

The time-limit failure remains a WS0 / issue #1 installer acceptance finding.
Successful direct npm installation does not establish that the installer wrapper
completed, nor that installation is fast on a cold Windows host.

This finding describes the `bfdbb23` baseline. It was retested and resolved for
the current attested package on 2026-09-12; see
fresh public artifact installation acceptance and provenance evidence.

## Limits of this result

These results establish the local candidate and installed artifact's contract
behavior. They do not establish a real Sherwood v2 verifier, signed discovery,
atomic cost enforcement, durable operation persistence, signed receipts, or
independent reproduction of intelligence claims. No v2 MCP tool was activated.

The artifact predates this report's addition; its code and fixtures are the
verified inputs, and the report is separate evidence rather than a self-hashed
release manifest. It has not been published as a package release.
Sherwood conformance, full evidence/receipt contracts, real hosts, and final
schema freeze remain on epic #3. Issues #1 and #2 retain their existing gates.
