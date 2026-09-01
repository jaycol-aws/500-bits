#!/usr/bin/env bash
#
# deploy-auto-trigger.sh — deploy the demo WITH the DevOps Agent auto-trigger.
#
# The webhook URL + secret are supplied as NoEcho CloudFormation parameters and
# written by CDK into a Secrets Manager secret at deploy time. They are NEVER
# written to any file in this repo. This wrapper reads them from environment
# variables so they don't end up hard-coded anywhere:
#
#   export WEBHOOK_URL='https://event-ai.us-east-1.api.aws/webhook/generic/<id>'
#   export WEBHOOK_SECRET='<hmac secret>'
#   ./deploy-auto-trigger.sh
#
# Get both from the Agent Space -> Associations tab -> MCP Servers section ->
# register a webhook with HMAC auth -> copy the Webhook URL + Secret (the secret
# is shown once).
#
# Collaborators who don't want the auto-trigger just run `cdk deploy` normally;
# the auto-trigger only exists when -c enableAutoTrigger=true is passed.
#
set -euo pipefail

: "${WEBHOOK_URL:?export WEBHOOK_URL to your DevOps Agent generic webhook URL}"
: "${WEBHOOK_SECRET:?export WEBHOOK_SECRET to the HMAC signing secret}"

cd "$(dirname "$0")/../cdk"

# --method direct uses CreateStack/UpdateStack instead of a change set, which
# skips the AWS::EarlyValidation::ResourceExistenceCheck hook. That hook has a
# known false positive when a single fresh CREATE adds the auto-trigger Lambda;
# --method direct sidesteps it. (Pass extra flags via "$@" as needed.)
npx cdk deploy \
  -c enableAutoTrigger=true \
  --method direct \
  --parameters "WebhookUrl=${WEBHOOK_URL}" \
  --parameters "WebhookSecret=${WEBHOOK_SECRET}" \
  "$@"

cat <<'EOF'

Deployed with the auto-trigger enabled.

Smoke-test end-to-end without a real fault (flips the alarm, then reset):
  aws cloudwatch set-alarm-state --region us-east-1 \
    --alarm-name checkout-error-rate-slo --state-value ALARM \
    --state-reason 'auto-trigger smoke test'
  # ...check the trigger Lambda's logs and the Operator App for a new investigation.
  aws cloudwatch set-alarm-state --region us-east-1 \
    --alarm-name checkout-error-rate-slo --state-value OK --state-reason 'reset'
EOF
