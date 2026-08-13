#!/bin/sh
# Fail fast and legibly when an image has not been prepared.
#
# Docker's own error for a missing local tag is `pull access denied ... repository does not
# exist or may require 'docker login'`, which reads as "you typed the name wrong" rather
# than "you have not done the one-time prerequisite". @tanifgit called this the single
# highest-value detail in the compose work (#72) because it is what a new person hits first.
#
# BOTH local tags, not just IRIS. Checking only IRIS is what this script was doing when the
# tags were first created for real: `productionguardian/irishealth:local` existed,
# `productionguardian/webgateway:local` did not, so preflight printed "present" and compose
# then failed on service 2 with precisely the pull-access-denied message above. A guard that
# passes and lets the guarded failure happen anyway is worse than no guard, because the
# reassuring line sends the reader looking somewhere else.
set -e

IRIS_IMAGE="${PG_IRIS_IMAGE:-productionguardian/irishealth:local}"
GATEWAY_IMAGE="${PG_WEBGATEWAY_IMAGE:-productionguardian/webgateway:local}"

missing=""
for image in "$IRIS_IMAGE" "$GATEWAY_IMAGE"; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "preflight: $image present"
  else
    echo "preflight: $image MISSING"
    missing="$missing $image"
  fi
done

if [ -z "$missing" ]; then
  exit 0
fi

cat <<EOF

  ====================================================================
  Not present locally:$missing

  This is a ONE-TIME prerequisite, not a failure. Neither image is
  pullable here: IRIS comes from the InterSystems Early Access Program,
  which needs a customer login rather than a registry credential, and
  the web gateway is tagged from whatever build you already have.

  IRIS ($IRIS_IMAGE):

    1. Download the AI Hub image from the EAP portal. It arrives as an
       OCI archive -- note the file may be named .tar.gz while actually
       being an uncompressed tar; docker load handles either.
    2. docker load -i <the-downloaded-file>
    3. docker tag <loaded-name>:<tag> $IRIS_IMAGE

  Web gateway ($GATEWAY_IMAGE):

    docker tag containers.intersystems.com/intersystems/webgateway:<tag> \\
      $GATEWAY_IMAGE

    Any version you already have works -- the gateway is bound to IRIS
    by CSP.ini, not by matching build numbers.

  Then re-run 'docker compose up'. See README.md section
  "Prerequisites" for the whole sequence.

  Why local tags rather than registry paths: compose then reproduces
  THE system our measurements were taken on, with no credentials in
  this repo and no network dependency (#72).
  ====================================================================

EOF
exit 1
