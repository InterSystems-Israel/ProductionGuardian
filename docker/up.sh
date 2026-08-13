#!/bin/sh
# Start the whole chain, with the preflight check actually wired in.
#
#   ./docker/up.sh
#
# WHY THIS EXISTS. `preflight.sh` was written to replace Docker's misleading
# `pull access denied` with an explanation of the one-time EAP prerequisite -- and then
# nothing invoked it. `git grep preflight` returned only prose: the README sentence, the
# compose header comment, and the script's own echoes. So the README heading
# "one time, and `compose up` will tell you if you skip it" was not true, and a new person
# got exactly the raw error preflight exists to prevent (@tanifgit, #78).
#
# A guard that never runs is the same category of defect as a guard that passes and lets the
# guarded failure happen. This is the smallest thing that makes the claim true.
#
# Plain `docker compose up` still works and is still documented -- this only adds the check
# and the two-step first boot, so nobody has to remember the order.
set -e

cd "$(dirname "$0")/.."

sh docker/preflight.sh

echo
echo "up: starting IRIS (a cold first boot takes minutes -- EnableNamespace is slow)"
# IRIS only. Its healthcheck now requires the LABDEMO production to be serving interop
# metrics, so waiting here is waiting for the thing dependents actually need. Starting
# everything at once would leave the proxy polling an instance with no production.
docker compose up -d iris

echo "up: waiting for IRIS to report ready (production serving interop metrics)..."
# 5 minutes, matching the healthcheck's own 60 x 5s budget.
i=0
while [ "$i" -lt 150 ]; do
  state=$(docker inspect --format '{{.State.Health.Status}}' pg-iris 2>/dev/null || echo missing)
  case "$state" in
    healthy) echo "up: IRIS ready"; break ;;
    missing) echo "up: pg-iris is not running -- see 'docker compose logs iris'" >&2; exit 1 ;;
  esac
  i=$((i + 1))
  sleep 2
done

if [ "$state" != "healthy" ]; then
  # FIRST BOOT: not an error. On a cold volume LABDEMO does not exist yet, so no production
  # is serving metrics and the healthcheck cannot pass until FirstBoot has run. That is the
  # documented two-step, and it is why this script runs FirstBoot on the way rather than
  # telling the user to.
  echo "up: IRIS is up but no production is serving yet -- running first-boot setup"
fi

# Idempotent (FirstBoot reports "exists" for every step), so running it unconditionally is
# safe and covers both the cold and warm cases without branching on a marker.
echo
echo "up: running first-boot setup"
# MSYS_NO_PATHCONV stops Git Bash on Windows rewriting the container-absolute path into a
# host one -- without it this becomes `C:/Program Files/Git/pg-firstboot.sh` and fails with
# "cannot open". Harmless on Linux and macOS, where the variable is simply unused.
# `sh <path>` rather than executing it directly: the script is mounted :ro, so its exec bit
# cannot be changed inside the container even though it is committed 100755.
MSYS_NO_PATHCONV=1 docker compose exec -T iris sh /pg-firstboot.sh

echo
# WAIT AGAIN AFTER FIRSTBOOT. The production has only just started, and interop metrics take
# a few seconds to appear -- so IRIS's healthcheck is still failing at this instant even
# though everything is correct. Starting the rest here failed with
# `dependency failed to start: container pg-iris is unhealthy`, which reads as a real fault
# rather than "asked one poll too early".
echo "up: waiting for interop metrics to appear..."
i=0
while [ "$i" -lt 60 ]; do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' pg-iris 2>/dev/null)" = "healthy" ]; then
    echo "up: IRIS healthy"
    break
  fi
  i=$((i + 1))
  sleep 2
done

echo
echo "up: starting the rest of the chain"
docker compose up -d

echo
docker compose ps
echo
echo "up: dashboard -> http://localhost:${PG_DASHBOARD_PORT:-5173}/?mode=live"
echo "up: IRIS      -> http://localhost:${PG_IRIS_WEB_PORT:-52773}/csp/sys/UtilHome.csp"
