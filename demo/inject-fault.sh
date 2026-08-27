#!/usr/bin/env bash
# Act 4 — inject an incident by flipping a feature flag in SSM Parameter Store.
#
# The app polls the SSM parameter every few seconds and adjusts its behavior.
# This keeps the service fully private (no inbound listener, no load balancer,
# no shell in the image) — a clean, copyable "fault-flag" pattern.
#
# Usage:
#   ./inject-fault.sh error 0.6     # 60% of checkouts fail
#   ./inject-fault.sh latency 0.5   # 50% get +0.8-1.5s latency
#   ./inject-fault.sh none          # recover
set -euo pipefail

REGION="${REGION:-us-east-1}"
PARAM="${FAULT_PARAM:-/500bits/fault}"
MODE="${1:-error}"
RATE="${2:-0.6}"

if [[ "$MODE" == "none" ]]; then
  VALUE="none"
else
  VALUE="${MODE}:${RATE}"
fi

echo "Setting $PARAM = $VALUE  (region $REGION)"
aws ssm put-parameter \
  --region "$REGION" \
  --name "$PARAM" \
  --type String \
  --overwrite \
  --value "$VALUE" >/dev/null

echo "Done. App picks it up within its poll interval (~5s). Watch the alarm query flip."
