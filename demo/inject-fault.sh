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
STACK="${STACK:-FiveHundredBitsStack}"
# The SSM parameter is auto-named by CloudFormation. Resolve it from the stack
# output (override with FAULT_PARAM=... if you already know the name).
PARAM="${FAULT_PARAM:-}"
if [[ -z "$PARAM" ]]; then
  PARAM=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='FaultParameterName'].OutputValue" \
    --output text 2>/dev/null || true)
fi
if [[ -z "$PARAM" || "$PARAM" == "None" ]]; then
  echo "ERROR: could not resolve the fault SSM parameter. Set FAULT_PARAM=<name>" >&2
  echo "       or STACK=<stack> (region $REGION), and ensure the stack is deployed." >&2
  exit 1
fi
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
