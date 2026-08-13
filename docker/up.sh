#!/bin/sh
# Start the whole chain, with the preflight check wired in.
#
#   ./docker/up.sh
#
# `docker compose up -d` on its own now does everything this does EXCEPT the preflight check
# -- first boot is automatic (compose passes `-a "sh /pg-firstboot.sh"` to the image's own
# entrypoint, which runs it after IRIS starts). So this script is a thin wrapper, not a
# required step, and the README documents both.
#
# WHY IT STILL EXISTS. `preflight.sh` was written to replace Docker's misleading
# `pull access denied` with an explanation of the one-time EAP prerequisite, and then nothing
# invoked it -- `git grep preflight` returned only prose (@tanifgit, #78). A guard that never
# runs is the same category of defect as a guard that passes and lets the guarded failure
# happen. Until compose gains a pre-hook of its own, this is the wiring.
set -e

cd "$(dirname "$0")/.."

sh docker/preflight.sh

echo
echo "up: starting the chain (a cold first boot takes a minute or two -- EnableNamespace is"
echo "up: slow, and IRIS reports healthy only once the production serves interop metrics)"
docker compose up -d

echo
docker compose ps
echo
echo "up: dashboard -> http://localhost:${PG_DASHBOARD_PORT:-5173}/?mode=live"
echo "up: IRIS      -> http://localhost:${PG_IRIS_WEB_PORT:-52773}/csp/sys/UtilHome.csp"
echo
echo "up: follow first boot with:  docker compose logs -f iris"
