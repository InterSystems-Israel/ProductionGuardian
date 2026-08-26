#!/bin/sh
# Take a bare IRIS container to a running LABDEMO production, once.
#
# POSIX sh, not bash. It is mounted :ro so its exec bit cannot be used inside the container,
# which means it is invoked as `sh /pg-firstboot.sh` -- and /bin/sh here is dash. A bash
# shebang would be a promise this file is never run under.
#
# Everything hard here is already in ProductionGuardian.Setup.FirstBoot (#73), which
# captured the nine manual steps from the #34/#53 deploy. This script is the thin part:
# wait for IRIS, create the namespace if absent, then call FirstBoot.
#
# IDEMPOTENT, because compose restarts containers. The marker file is belt to FirstBoot's
# own braces -- it already reports "exists" for every step, so a second run is safe rather
# than merely skipped.
set -e

MARKER=/iris-shared/durable/.pg-firstboot-done
SRC=/pg-src/labdemo/
SETUP_SRC=/pg-src/setup/

echo "pg-firstboot: waiting for IRIS to accept a session..."
ready=0
for i in $(seq 1 120); do
  # `echo | ` rather than a `<<<` herestring: this file is invoked as `sh <path>` (its exec
  # bit cannot be used from a :ro mount), and /bin/sh in this image is dash, where `<<<` is a
  # syntax error -- `Syntax error: redirection unexpected`, which aborts before the first
  # message and so reads as the script being broken rather than one line being bash-only.
  if echo 'halt' | iris session IRIS -U %SYS >/dev/null 2>&1; then
    echo "pg-firstboot: IRIS is up"
    ready=1
    break
  fi
  sleep 2
done

# FAIL LOUDLY. This loop used to fall through silently after 4 minutes, and the next
# `iris session` then died under `set -e` with whatever IRIS said -- so the actual fact
# ("IRIS never accepted a session") was never printed, and the visible error was a
# downstream symptom. That is the wrong message to be reading at 4am (@tanifgit, #78).
if [ "$ready" -ne 1 ]; then
  echo "pg-firstboot: FAILED -- IRIS did not accept a session within 240s." >&2
  echo "pg-firstboot: check 'docker compose logs iris'; the instance may still be initialising" >&2
  echo "pg-firstboot: (a cold EnableNamespace takes minutes) or may have failed to start." >&2
  exit 1
fi

if [ -f "$MARKER" ]; then
  echo "pg-firstboot: already done, re-running FirstBoot to verify (it is idempotent)"
fi

# NAMESPACE FIRST, and separately: EnableNamespace takes minutes and can drop the
# connection mid-call, which is the config activating rather than a failure. FirstBoot
# deliberately refuses rather than doing this, so it stays a fast idempotent check.
iris session IRIS -U %SYS <<'OBJECTSCRIPT'
set ns = "LABDEMO"
if ##class(%Library.EnsembleMgr).IsEnsembleNamespace(ns) {
    write "namespace ", ns, ": already interop-enabled", !
} else {
    set dir = "/iris-shared/durable/mgr/labdemo"
    do ##class(%Library.File).CreateDirectoryChain(dir)
    set sc = ##class(SYS.Database).CreateDatabase(dir)
    write "database: ", $select(sc: "created", 1: $system.Status.GetErrorText(sc)), !
    kill p  set p("Directory") = dir
    set sc = ##class(Config.Databases).Create(ns, .p)
    write "db registered: ", $select(sc: "yes", 1: $system.Status.GetErrorText(sc)), !
    kill p  set p("Globals") = ns, p("Routines") = ns
    set sc = ##class(Config.Namespaces).Create(ns, .p)
    write "namespace created: ", $select(sc: "yes", 1: $system.Status.GetErrorText(sc)), !
    write "enabling interop (this takes a few minutes)...", !
    set sc = ##class(%Library.EnsembleMgr).EnableNamespace(ns, 1)
    write "interop: ", $select(sc: "enabled", 1: $system.Status.GetErrorText(sc)), !
}
halt
OBJECTSCRIPT

# Then the nine steps, in one call. Compile from the read-only source mount so a class
# change is a restart rather than an image rebuild.
#
# SET THE DEPLOYMENT GLOBALS FIRST. These are now an OVERRIDE rather than a repair:
# Production.cls ships HTTPServer=127.0.0.1 and HTTPPort=52773, the same values defaulted
# below, so on this stack step 6b confirms the target instead of rescuing it.
#
# IT USED TO BE A REPAIR, AND THAT IS WHY THE GLOBALS ARE STILL SET HERE. Production.cls
# shipped HTTPServer=webgateway-webinar, the separate demo instance's web gateway container
# name, which shares no docker network with this stack and so never resolved here.
# ApplyDeploymentSettings() was the only thing making Cloud API work, and it is a no-op
# unless these globals are set BEFORE Run() reaches step 6b -- nothing set them, so the
# first clean compose run printed "6b. deployment settings: none set" and Cloud API sat in
# Retry with 151 messages queued while every other host read OK.
#
# That failure is quiet in the way that matters -- the production runs, metrics flow, the
# dashboard renders three hosts, and the only clue is one host retrying against a hostname
# that never existed here. Worse, this script is marker-gated, so the rescue happened once
# per volume and any later revert to the shipped value was permanent and invisible: that is
# the "findings appear and disappear with no clear cause" report. Fixing the shipped default
# is what closed it; keeping these globals keeps a gateway-fronted deployment configurable.
#
# THE TARGET IS THIS CONTAINER'S OWN EMBEDDED APACHE. Cloud API runs inside IRIS and the
# private web server is in the same container, so 127.0.0.1:52773 is both correct and one
# fewer network hop -- there is no gateway service any more. Overridable for a deployment
# that does front IRIS with an external gateway, which is what the demo instance does.
HTTP_SERVER="${PG_IRIS_HTTP_SERVER:-127.0.0.1}"
HTTP_PORT="${PG_IRIS_HTTP_PORT:-52773}"

iris session IRIS -U LABDEMO <<OBJECTSCRIPT
set ^ProductionGuardian.Setup("HTTPServer") = "$HTTP_SERVER"
set ^ProductionGuardian.Setup("HTTPPort") = $HTTP_PORT
write "deployment target: $HTTP_SERVER:$HTTP_PORT", !
set sc = \$system.OBJ.LoadDir("$SETUP_SRC", "ck", .e, 1)
write "setup classes: ", \$select(sc: "compiled", 1: \$system.Status.GetErrorText(sc)), !
set sc = ##class(ProductionGuardian.Setup.FirstBoot).Run("$SRC", 1)
write "FirstBoot: ", \$select(sc: "OK", 1: \$system.Status.GetErrorText(sc)), !
halt
OBJECTSCRIPT

touch "$MARKER"
echo "pg-firstboot: done"
