# Linux prerequisite bootstrap

On a supported Linux host, download this repository's `scripts/bootstrap-linux.sh`, inspect it, and run it with Bash:

```sh
curl --fail --location --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/gossip-dev/gossip/main/scripts/bootstrap-linux.sh --output bootstrap-linux.sh
bash bootstrap-linux.sh --install-system-deps
. "$HOME/.local/share/gossip-runtime/env.sh"
node --version
```

The script is a plain file download followed by a local Bash invocation; it never pipes network content to a shell.

The bootstrap supports glibc Linux on `x86_64` and `aarch64`/`arm64`. It installs the pinned official Node.js 24.13.1 archive, including its bundled npm, under `~/.local/share/gossip-runtime` unless `--prefix ABSOLUTE_PATH` is supplied. It verifies the architecture-specific SHA-256 digest before publishing the runtime and does not replace a system Node installation. Rerunning it reuses an already verified matching runtime. A conflicting runtime or environment file is preserved and causes a failure.

`--install-system-deps` is opt-in. On apt-based systems it installs `ca-certificates`, `curl`, `xz-utils`, `libsecret-tools`, `dbus-user-session`, and `gnome-keyring`, using root or non-interactive `sudo -n`. The script never invokes sudo without this flag and does not manually launch or unlock a keyring. Installing system packages changes the machine and may trigger distribution service hooks.

The bootstrap does not create a wallet, generate or unlock secrets, connect to an engine, or claim that Gossip is connected. It only reports Secret Service as detected when both `secret-tool` and `DBUS_SESSION_BUS_ADDRESS` are present; keyring unlock and identity setup remain pending. Exit status 3 means the Node runtime is ready but storage prerequisites are pending. Exit status 0 means the runtime and those process-level storage prerequisites were detected. Exit status 1 indicates an install or conflict failure; exit status 2 indicates invalid usage, unsupported platform, or missing prerequisites.

The expected archive digests are pinned in the script from the official Node.js release checksums:

| Architecture | Archive SHA-256 |
| --- | --- |
| Linux x86_64 | `30215f90ea3cd04dfbc06e762c021393fa173a1d392974298bbc871a8e461089` |
| Linux arm64 | `c827d3d301e2eed1a51f36d0116b71b9e3d9e3b728f081615270ea40faac34c1` |

## Validation

The process test `test/bootstrap-linux.sh` passed in `node:20.19.2-bookworm-slim` (image digest `sha256:7cd3fbc830c75c92256fe1122002add9a1c025831af8770cd0bf8e45688ef661`). It installed actual apt packages and the checksum-verified official archive, exercised an idempotent rerun, preserved system Node 20 and an unrelated occupied directory, and reported storage pending because there was no user session. Linux x64 was exercised; arm64 remains unverified.

After building the repository, reproduce with:

```sh
docker run --rm -v "$PWD:/repo:ro" node:20.19.2-bookworm-slim bash /repo/test/bootstrap-linux.sh
```

This does not establish Grok Bot MCP compatibility or an available Gossip engine endpoint.
