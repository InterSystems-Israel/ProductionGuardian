#!/bin/sh
# Fail fast and legibly when an image has not been prepared.
#
# Docker's own error for a missing local tag is `pull access denied ... repository does not
# exist or may require 'docker login'`, which reads as "you typed the name wrong" rather
# than "you have not done the one-time prerequisite". @tanifgit called this the single
# highest-value detail in the compose work (#72) because it is what a new person hits first.
#
# ONE image to check, since the webgateway service is gone (the EAP image serves HTTP itself).
# An earlier version checked only IRIS while a gateway tag was also required, printed
# "present", and let compose fail on service 2 with precisely the pull-access-denied message
# above -- a guard that passes and lets the guarded failure happen is worse than no guard,
# because the reassuring line sends the reader looking somewhere else. Keep this loop covering
# EVERY local tag compose needs, so re-adding one re-adds its check.
set -e

IRIS_IMAGE="${PG_IRIS_IMAGE:-productionguardian/irishealth:local}"

missing=""
for image in "$IRIS_IMAGE"; do
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

  This is a ONE-TIME prerequisite, not a failure. The image is not
  pullable: it comes from the InterSystems Early Access Program, which
  needs a customer login rather than a registry credential.

    1. Download the AI Hub image from the EAP portal. It arrives as an
       OCI archive -- note the file may be named .tar.gz while actually
       being an uncompressed tar; docker load handles either.
    2. docker load -i <the-downloaded-file>
    3. docker tag <loaded-name>:<tag> $IRIS_IMAGE

  Then re-run 'docker compose up'. See README.md section
  "Prerequisites" for the whole sequence.

  Why a local tag rather than a registry path: compose then reproduces
  THE system our measurements were taken on, with no credentials in
  this repo and no network dependency (#72).
  ====================================================================

EOF
exit 1
