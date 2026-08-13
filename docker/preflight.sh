#!/bin/sh
# Fail fast and legibly when the IRIS image has not been prepared.
#
# Docker's own error for a missing local tag is `pull access denied ... repository does not
# exist or may require 'docker login'`, which reads as "you typed the name wrong" rather
# than "you have not done the one-time prerequisite". @tanifgit called this the single
# highest-value detail in the compose work (#72) because it is what a new person hits first.
set -e

IMAGE="${PG_IRIS_IMAGE:-productionguardian/irishealth:local}"

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "preflight: $IMAGE present"
  exit 0
fi

cat <<EOF

  ====================================================================
  The IRIS image '$IMAGE' is not present locally.

  This is a ONE-TIME prerequisite, not a failure. The image is not
  pullable: it comes from the InterSystems Early Access Program, which
  needs a customer login rather than a registry credential.

    1. Download the AI Hub image from the EAP portal
    2. docker load -i <the-downloaded-file>
    3. docker tag <loaded-name>:<tag> $IMAGE

  Then re-run 'docker compose up'. See README.md section
  "Prerequisites" for the whole sequence.

  Why a local tag rather than a registry path: compose then reproduces
  THE system our measurements were taken on, with no credentials in
  this repo and no network dependency (#72).
  ====================================================================

EOF
exit 1
