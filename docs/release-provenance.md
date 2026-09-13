# Release provenance

The repository has a deterministic, artifact-only release-provenance workflow.
It builds the package from the current clean commit and writes a
machine-readable `gossip.release-provenance.v1` manifest beside the tarball.
The manifest binds:

- the full Git commit and origin URL;
- the package name and version from `package.json`;
- the SHA-256 digest and byte count of `package-lock.json`;
- the normalized npm package filename, SHA-256 digest, and byte count;
- the exact Node.js and npm versions used; and
- the install, typecheck, test, build, and pack results.

Run it from a clean checkout with Node.js 24 or newer. Both output paths must be
absolute and outside the checkout so generated evidence cannot make its source
tree dirty:

```powershell
$out = Join-Path $env:TEMP "gossip-release-provenance.json"
$artifact = Join-Path $env:TEMP "gossip-agent-kit.tgz"
npm run release:provenance -- --output $out --artifact $artifact
npm run verify:release-provenance -- --manifest $out --artifact $artifact
```

The builder refuses a dirty tree, runs `npm ci --ignore-scripts`, and stops
without writing a successful manifest if any check fails. The verifier checks
the checkout is still clean, resolves the current commit and package metadata,
rehashes the lockfile and tarball, and compares the measured Node.js/npm
versions and every required check. A changed source commit, lockfile, package,
artifact, runtime, or check result fails closed.

The manual GitHub Actions workflow runs this same command, creates a signed
GitHub artifact attestation for the tarball, and uploads the manifest and
tarball as a reviewable artifact. The attestation binds the package digest to
the public `gossip-dev/gossip` repository, exact commit, and workflow identity
through GitHub's OIDC and Sigstore service. Every third-party action is pinned
to a reviewed commit.

After downloading the workflow artifact, verify both layers:

```bash
npm run verify:release-provenance -- \
  --manifest /absolute/path/gossip-release-provenance.json \
  --artifact /absolute/path/gossip-agent-kit.tgz
gh attestation verify /absolute/path/gossip-agent-kit.tgz \
  --repo gossip-dev/gossip
```

The local manifest checks package inputs and build results. The GitHub
attestation establishes who built those bytes and from which repository
workflow. A successful manual run does not create a Git tag or release,
publish to npm, deploy an endpoint, or assert signed production or host
acceptance. Those actions remain explicit later decisions after their separate
gates pass.
