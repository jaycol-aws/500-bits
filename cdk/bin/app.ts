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

new FiveHundredBitsStack(app, 'FiveHundredBitsStack', {
  // SPEC.md: Region is us-east-1. Pin it explicitly rather than relying on
  // the ambient CLI/profile region so image assets and the metrics endpoint
  // always resolve to the same region.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description:
    "500 Bits to Impact demo: Fargate checkout-service with an ADOT collector " +
    "sidecar exporting OTLP metrics to CloudWatch (us-east-1).",
});

app.synth();
