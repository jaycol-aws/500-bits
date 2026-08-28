#!/usr/bin/env node
/**
 * CDK application entry point for the "500 Bits to Impact" demo.
 *
 * Pins the deployment to us-east-1 (the region where the DevOps Agent
 * "Olympus" Agent Space lives, per SPEC.md) so the CloudWatch OTLP metrics
 * endpoint and the SigV4-signed exporter line up with the query path.
 */
import * as cdk from 'aws-cdk-lib';
import { FiveHundredBitsStack } from '../lib/five-hundred-bits-stack';

const app = new cdk.App();

// Region defaults to us-east-1 (where the reference Agent Space lives). Override
// with `-c region=<region>` or the ambient CDK_DEFAULT_REGION to run anywhere
// CloudWatch OTLP metrics + a DevOps Agent Space are available.
const region =
  app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'us-east-1';

new FiveHundredBitsStack(app, 'FiveHundredBitsStack', {
  // Pin the resolved region explicitly so image assets, the metrics endpoint,
  // and the SigV4 signer all line up.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description:
    "500 Bits to Impact demo: Fargate checkout-service with an OpenTelemetry " +
    "Collector sidecar exporting OTLP metrics to CloudWatch.",
});

app.synth();
