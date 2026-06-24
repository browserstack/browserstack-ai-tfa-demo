#!/usr/bin/env bash
# Upload the JUnit results to BrowserStack Observability (rengg-tfa staging),
# creating the project + build that the RCA plugin then runs against.
#
# Creds come from the environment — never commit them:
#   export BSTACK_USER=...   BSTACK_KEY=...
# (or `source automation/.env`, which is gitignored.)
set -euo pipefail

UPLOAD_URL="${O11Y_UPLOAD_URL:-https://upload-observability-rengg-tfa.bsstag.com/upload}"
XML="${1:-$(dirname "$0")/build-rca-failures.xml}"
PROJECT="${PROJECT_NAME:-RCA Feature Fencing}"
BUILD="${BUILD_NAME:-VRT Build}"

: "${BSTACK_USER:?set BSTACK_USER}"
: "${BSTACK_KEY:?set BSTACK_KEY}"

curl -sS -X POST "$UPLOAD_URL" \
  -u "${BSTACK_USER}:${BSTACK_KEY}" \
  -F "data=@${XML}" \
  -F "projectName=${PROJECT}" \
  -F "buildName=${BUILD}"
echo
