#!/bin/sh
# Generate CSP.ini from the committed template, injecting the CSPSystem password.
#
# The gateway needs an obfuscated password in its config, and we do not commit one (see the
# template header). IRIS obfuscation of the default `SYS` is `]]]U1lT`, which is what the
# verified instance uses -- so the default here reproduces that instance while keeping the
# value out of git.
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
