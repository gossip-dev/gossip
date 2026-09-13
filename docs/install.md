# Installing a packaged Gossip kit

Source installation from the pinned checkout is the default onboarding path.
Use this artifact installer only when the exact local package and its expected
SHA-256 digest have been supplied separately.

The installer accepts one locally supplied package artifact and an expected SHA-256 digest. It never resolves a package name or URL. The digest is an out-of-band trust decision and is not an artifact locator: matching it proves that the bytes are the bytes you were given, but does not by itself prove who published them.

Use Node.js 24 or newer and an absolute destination path that does not exist:

```text
node scripts/install.mjs \
  --artifact /path/to/gossip-agent-kit-0.1.0.tgz \
  --sha256 <64-hex-digest> \
  --destination /path/to/gossip-kit
```

The installer verifies the artifact before creating the destination, then runs `npm install` with the local artifact, `--offline`, `--ignore-scripts`, `--no-audit`, and `--no-fund`. Offline mode prevents package dependencies from being fetched from a registry; a package whose dependencies are not already available in npm's cache will fail cleanly. The generated npm lockfile remains in the installed destination and records the resolved package tree.

An existing destination is refused, including an empty directory. A rerun is accepted only when `.gossip-install.json` contains the same verified artifact digest and the installed `@gossip/agent-kit` manifest plus `dist/cli.js` are present. The installer copies the artifact into a private sibling staging directory before hashing it, and removes only that directory if npm fails; it never removes or modifies an existing destination. npm diagnostics are kept out of installer output so package-manager subprocess text cannot leak credentials.

This installer installs software only. It does not create, import, fund, or publish a wallet or perform any chain operation.
