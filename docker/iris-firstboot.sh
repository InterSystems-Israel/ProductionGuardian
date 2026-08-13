#!/bin/bash
# Take a bare IRIS container to a running LABDEMO production, once.
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
for i in $(seq 1 120); do
  if iris session IRIS -U %SYS <<< 'halt' >/dev/null 2>&1; then
    echo "pg-firstboot: IRIS is up"
    break
  fi
  sleep 2
done

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
# SET THE DEPLOYMENT GLOBALS FIRST. Production.cls ships HTTPServer=webgateway-webinar --
# the verified demo instance's web gateway container name, which does not resolve on the
# compose network. ApplyDeploymentSettings() exists precisely to override it, but it is a
# no-op unless these globals are set BEFORE Run() reaches step 6b, and nothing set them:
# the first clean compose run printed "6b. deployment settings: none set" and Cloud API then
# sat in Retry with 151 messages queued while every other host read OK.
#
# That failure is quiet in the way that matters -- the production runs, metrics flow, the
# dashboard renders three hosts, and the only clue is one host retrying against a hostname
# that never existed here.
#
# PG_WEBGATEWAY_SERVICE lets a differently-named compose service override it without
# touching the production.
GATEWAY_SERVICE="${PG_WEBGATEWAY_SERVICE:-webgateway}"
GATEWAY_PORT="${PG_WEBGATEWAY_INTERNAL_PORT:-80}"

iris session IRIS -U LABDEMO <<OBJECTSCRIPT
set ^ProductionGuardian.Setup("HTTPServer") = "$GATEWAY_SERVICE"
set ^ProductionGuardian.Setup("HTTPPort") = $GATEWAY_PORT
write "deployment target: $GATEWAY_SERVICE:$GATEWAY_PORT", !
set sc = \$system.OBJ.LoadDir("$SETUP_SRC", "ck", .e, 1)
write "setup classes: ", \$select(sc: "compiled", 1: \$system.Status.GetErrorText(sc)), !
set sc = ##class(ProductionGuardian.Setup.FirstBoot).Run("$SRC", 1)
write "FirstBoot: ", \$select(sc: "OK", 1: \$system.Status.GetErrorText(sc)), !
halt
OBJECTSCRIPT

touch "$MARKER"
echo "pg-firstboot: done"
