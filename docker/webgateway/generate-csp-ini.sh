#!/bin/sh
# Generate CSP.ini from the committed template, injecting the CSPSystem password.
#
# NOT USED BY docker-compose.yml ANY MORE. The EAP image serves HTTP itself on 52773, so the
# compose stack has no webgateway service (#78). These files are kept because the demo
# instance IS fronted by an external gateway, and that is a configuration we still need to be
# able to reproduce -- but nothing in compose calls this.
#
# The gateway needs an obfuscated password in its config. To be precise about what is and is
# not protected here, because the template used to overclaim it (@tanifgit, #78): the
# RENDERED CSP.ini is not committed and is gitignored. The DEFAULT VALUE below is in the repo.
# It is IRIS's obfuscation of `SYS` for the built-in CSPSystem gateway account -- a
# well-known default rather than a user credential -- and PG_CSP_PASSWORD overrides it.
#
# So the honest claim is "the rendered file is not committed", not "no credential is in the
# repo". Failing loudly when PG_CSP_PASSWORD is unset was the alternative; it would break the
# demo instance's reproducibility for a value that is public in every InterSystems install, so
# the default stays and the wording is corrected instead.
set -e

TEMPLATE=/webgateway-shared/CSP.ini.example
TARGET=/webgateway-shared/CSP.ini
PASS="${PG_CSP_PASSWORD:-]]]U1lT}"

if [ -f "$TARGET" ]; then
  echo "csp-ini: $TARGET exists, leaving it alone"
  exit 0
fi

sed "s|Password=<set by docker/webgateway/generate-csp-ini.sh>|Password=$PASS|" \
  "$TEMPLATE" > "$TARGET"
echo "csp-ini: generated $TARGET from template"
