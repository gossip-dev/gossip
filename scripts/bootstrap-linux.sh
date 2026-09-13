#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="24.13.1"
DEFAULT_PREFIX="${HOME}/.local/share/gossip-runtime"
PREFIX="${DEFAULT_PREFIX}"
INSTALL_SYSTEM_DEPS=0
LOCK_HELD=0
TEMP_DIR=""

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-linux.sh [--prefix ABSOLUTE_PATH] [--install-system-deps]

Install the pinned Node.js runtime used by Gossip under a user-selected prefix.
The default is ~/.local/share/gossip-runtime. No system Node installation is changed.
--install-system-deps may use apt-get as root or sudo -n to install prerequisite packages.
EOF
}

fail() {
  printf 'bootstrap: %s\n' "$1" >&2
  exit "${2:-1}"
}

cleanup() {
  if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]]; then
    rm -rf -- "${TEMP_DIR}"
  fi
  if [[ "${LOCK_HELD}" -eq 1 ]]; then
    rmdir -- "${PREFIX}/.bootstrap.lock" 2>/dev/null || true
  fi
}
trap cleanup EXIT

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --prefix)
      [[ "$#" -ge 2 ]] || fail '--prefix requires an absolute path' 2
      PREFIX="$2"
      shift 2
      ;;
    --install-system-deps)
      INSTALL_SYSTEM_DEPS=1
      shift
      ;;
    *)
      fail "unknown option: $1 (use --help)" 2
      ;;
  esac
done

[[ "$PREFIX" = /* ]] || fail '--prefix must be an absolute path' 2
[[ "$PREFIX" != '/' && "$PREFIX" != *$'\n'* && "$PREFIX" != *$'\r'* ]] || fail '--prefix is not a safe dedicated directory' 2
[[ ! -L "$PREFIX" ]] || fail 'refusing a symlinked prefix' 2
if [[ -d "$PREFIX" && ! -f "${PREFIX}/.gossip-runtime" && -n "$(ls -A -- "$PREFIX")" ]]; then
  fail 'prefix contains unrelated files; choose a new dedicated directory' 1
fi

[[ "$(uname -s)" == 'Linux' ]] || fail 'this bootstrap supports Linux only' 2
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH='x64'; EXPECTED_SHA256='30215f90ea3cd04dfbc06e762c021393fa173a1d392974298bbc871a8e461089' ;;
  aarch64|arm64) NODE_ARCH='arm64'; EXPECTED_SHA256='c827d3d301e2eed1a51f36d0116b71b9e3d9e3b728f081615270ea40faac34c1' ;;
  *) fail "unsupported Linux architecture: ${ARCH} (supported: x86_64, aarch64)" 2 ;;
esac

if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi 'musl'; then
  fail 'musl libc is unsupported; use a glibc-based Linux distribution' 2
fi
if command -v getconf >/dev/null 2>&1; then
  getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail 'glibc is required; this host does not report GNU libc' 2
fi

install_system_deps() {
  command -v apt-get >/dev/null 2>&1 || fail '--install-system-deps requires apt-get' 2
  if [[ "$(id -u)" -eq 0 ]]; then
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils libsecret-tools dbus-user-session gnome-keyring
  else
    command -v sudo >/dev/null 2>&1 || fail '--install-system-deps requires root or sudo' 2
    sudo -n apt-get update || fail 'sudo -n was refused; run as root or configure non-interactive sudo' 2
    sudo -n apt-get install -y --no-install-recommends ca-certificates curl xz-utils libsecret-tools dbus-user-session gnome-keyring || fail 'sudo -n apt installation failed' 2
  fi
}

if [[ "$INSTALL_SYSTEM_DEPS" -eq 1 ]]; then
  install_system_deps
fi

for required in curl xz sha256sum; do
  command -v "$required" >/dev/null 2>&1 || fail "missing ${required}; rerun with --install-system-deps on apt-based Linux" 2
done

mkdir -p -- "$PREFIX"
if ! mkdir -- "${PREFIX}/.bootstrap.lock" 2>/dev/null; then
  fail "prefix is busy: ${PREFIX}" 1
fi
LOCK_HELD=1
printf 'Gossip runtime bootstrap v1\n' > "${PREFIX}/.gossip-runtime"

RUNTIME_DIR="${PREFIX}/node-v${NODE_VERSION}"
[[ ! -L "$RUNTIME_DIR" ]] || fail 'refusing a symlinked runtime' 1
if [[ -e "$RUNTIME_DIR" ]]; then
  [[ -x "${RUNTIME_DIR}/bin/node" ]] || fail "existing runtime is not the pinned Node.js ${NODE_VERSION}; refusing to overwrite" 1
  [[ "$("${RUNTIME_DIR}/bin/node" --version 2>/dev/null)" == "v${NODE_VERSION}" ]] || fail "existing runtime is not Node.js ${NODE_VERSION}; refusing to overwrite" 1
  [[ -x "${RUNTIME_DIR}/bin/npm" ]] || fail 'existing pinned runtime has no bundled npm; refusing to overwrite' 1
else
  TEMP_DIR="$(mktemp -d "${PREFIX}/.bootstrap.XXXXXX")"
  ARCHIVE="${TEMP_DIR}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl --fail --silent --show-error --proto '=https' --proto-redir '=https' --location --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 120 --output "$ARCHIVE" "$URL" || fail 'could not download the pinned Node.js archive over HTTPS' 1
  ACTUAL_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  [[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256" ]] || fail 'downloaded Node.js archive failed the pinned SHA-256 check' 1
  tar -xJf "$ARCHIVE" -C "$TEMP_DIR" || fail 'could not unpack the verified Node.js archive' 1
  [[ -d "${TEMP_DIR}/node-v${NODE_VERSION}-linux-${NODE_ARCH}" ]] || fail 'Node.js archive had an unexpected layout' 1
  mv -- "${TEMP_DIR}/node-v${NODE_VERSION}-linux-${NODE_ARCH}" "$RUNTIME_DIR" || fail 'could not publish the runtime without overwriting existing data' 1
fi

ENV_FILE="${PREFIX}/env.sh"
[[ ! -L "$ENV_FILE" ]] || fail 'refusing a symlinked environment file' 1
ENV_TEMP="${PREFIX}/.env.sh.${BASHPID}.tmp"
ENV_CONTENT="$(printf 'export GOSSIP_RUNTIME_PREFIX=%q\nexport PATH=%q:"${PATH}"\n' "$PREFIX" "${RUNTIME_DIR}/bin")"
if [[ -e "$ENV_FILE" ]]; then
  EXISTING_ENV="$(cat "$ENV_FILE")"
  [[ "$EXISTING_ENV" == "$ENV_CONTENT" ]] || fail "existing ${ENV_FILE} differs; refusing to overwrite" 1
else
  printf '%s\n' "$ENV_CONTENT" > "$ENV_TEMP"
  chmod 0644 "$ENV_TEMP"
  mv -- "$ENV_TEMP" "$ENV_FILE" || fail "could not create ${ENV_FILE}" 1
fi

printf 'Node.js %s is ready under %s\n' "$NODE_VERSION" "$RUNTIME_DIR"
printf 'Source the environment with: . %q\n' "$ENV_FILE"
if command -v secret-tool >/dev/null 2>&1 && [[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  printf 'Secret Service: detected; keyring unlock and Gossip identity setup remain pending.\n'
  exit 0
fi
printf 'Secret Service: pending; no wallet secret was created. Start a user DBus/keyring session and install secret-tool before identity setup.\n'
exit 3
