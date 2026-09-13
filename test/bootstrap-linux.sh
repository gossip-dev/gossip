#!/usr/bin/env bash
set -euo pipefail
node /repo/dist/cli.js --help
node /repo/dist/cli.js doctor --directory /tmp/gossip-unused | grep '"runtimeSupported":false'
test ! -e /tmp/gossip-unused
bash /repo/scripts/bootstrap-linux.sh --help
set +e
bash /repo/scripts/bootstrap-linux.sh --prefix /tmp/gossip-runtime --install-system-deps
result=$?
set -e
test "$result" -eq 3
source /tmp/gossip-runtime/env.sh
test "$(node --version)" = v24.13.1
test "$(/usr/local/bin/node --version)" = v20.19.2
npm --version
set +e
bash /repo/scripts/bootstrap-linux.sh --prefix /tmp/gossip-runtime
result=$?
set -e
test "$result" -eq 3
test "$(node --version)" = v24.13.1
mkdir /tmp/occupied-runtime
printf 'preserve' > /tmp/occupied-runtime/keep
if bash /repo/scripts/bootstrap-linux.sh --prefix /tmp/occupied-runtime; then exit 1; fi
test "$(cat /tmp/occupied-runtime/keep)" = preserve
printf 'Bootstrap acceptance passed; protected storage correctly remains pending.\n'
