import * as path from 'path';
import * as fs from 'fs';
import { Construct } from 'constructs';
import {
  Stack,
  StackProps,
  CfnOutput,
  CfnParameter,
  SecretValue,
  RemovalPolicy,
  Tags,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { DevOpsAgentAutoTrigger } from './devops-auto-trigger';

/**
 * FiveHundredBitsStack
 *
 * Provisions the runtime for the "500 Bits to Impact" demo:
 *   - a dedicated VPC (2 AZs, public subnets only, no NAT gateway)
 *   - an ECS cluster
 *   - a single Fargate task running TWO containers:
 *       1. the "checkout-service" app (built from ../app) on port 8080
 *          with an internal load generator, exporting OTLP/gRPC to
 *          localhost:4317
 *       2. an upstream OpenTelemetry Collector (contrib) sidecar that receives
 *          OTLP on 4317/4318 and exports metrics to the CloudWatch OTLP
 *          metrics endpoint via otlphttp + sigv4auth
 *
 * All names, ports, endpoints, and resource attributes are dictated by
 * SPEC.md (the canonical demo contract).
 */
export class FiveHundredBitsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Tag every resource in the stack for cost tracking / ownership.
    Tags.of(this).add('project', '500-bits-to-impact');
    Tags.of(this).add('environment', 'demo');

    // ---------------------------------------------------------------------
    // Networking — dedicated VPC (self-contained, no external references)
    // ---------------------------------------------------------------------
    // We create our OWN VPC rather than reusing the account's default VPC.
    // Reasons:
    //   1. Self-contained IaC — the stack owns every resource it references,
    //      so `cdk deploy` works in any bootstrapped account with no reliance
    //      on a pre-existing default VPC or a cached `cdk.context.json` lookup.
    //   2. Avoids CloudFormation pre-deployment ResourceExistenceCheck errors
    //      that can flag looked-up (external) subnet/VPC IDs.
    //   3. Clean teardown — `cdk destroy` removes the whole network.
    //
    // PUBLIC-only, natGateways: 0 keeps it cheap: the Fargate task runs in a
    // public subnet with a public IP for egress (ECR pulls + the CloudWatch
    // OTLP endpoint). Its security group opens NO inbound ports, so there is
    // no inbound exposure — same posture as before, now fully owned.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/16'),
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // ---------------------------------------------------------------------
    // ECS cluster
    // ---------------------------------------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ---------------------------------------------------------------------
    // Shared log group for both containers (awslogs driver)
    // ---------------------------------------------------------------------
    // Auto-named by CloudFormation (no fixed logGroupName) so the stack can be
    // deployed more than once per account/Region without a name collision.
    // ONE_WEEK retention keeps demo logs cheap; DESTROY removal keeps teardown
    // (and rollback) clean — no orphaned log group to collide on the next create.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------------------------------------------------------------------
    // Task definition (one task, two containers)
    // ---------------------------------------------------------------------
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      // Build/run on Graviton (ARM64). Matches a natively-built arm64 image on
      // Apple Silicon and avoids an arch mismatch ("exec format error").
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // The TASK ROLE is the identity the running containers assume. The
    // collector's sigv4auth exporter signs requests as this role, so it needs
    // cloudwatch:PutMetricData. SPEC.md requires Resource '*' (PutMetricData
    // does not support resource-level scoping).
    taskDefinition.taskRole.attachInlinePolicy(
      new iam.Policy(this, 'PutMetricDataPolicy', {
        statements: [
          new iam.PolicyStatement({
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
          }),
        ],
      }),
    );

    // ---------------------------------------------------------------------
    // Fault-flag parameter (Act 4 incident switch)
    // ---------------------------------------------------------------------
    // The app polls this SSM parameter every ~5s. demo/inject-fault.sh writes
    // "error:0.6" | "latency:0.5" | "none" here to drive/recover the incident.
    // This keeps the service fully private — no inbound path required.
    // Auto-named (no fixed parameterName) for the same multi-deploy reason. The
    // app receives the generated name via FAULT_PARAM; demo/inject-fault.sh
    // resolves it from the FaultParameterName stack output.
    const faultParam = new ssm.StringParameter(this, 'FaultFlag', {
      stringValue: 'none',
      description: '500 Bits demo fault-injection flag: none | error:<rate> | latency:<rate>',
    });
    faultParam.grantRead(taskDefinition.taskRole);

    // ---------------------------------------------------------------------
    // Container 1: the checkout-service app (built from ../app)
    // ---------------------------------------------------------------------
    // Exports OTLP/gRPC to the collector sidecar over the shared task
    // loopback (localhost:4317). An internal load generator inside the app
    // keeps ~5 rps flowing so metrics are always present during the demo.
    const appContainer = taskDefinition.addContainer('AppContainer', {
      containerName: 'checkout-service',
      image: ecs.ContainerImage.fromAsset(path.resolve(__dirname, '..', '..', 'app'), {
        platform: Platform.LINUX_ARM64,
      }),
      essential: true,
      environment: {
        // Sidecar receives OTLP/gRPC on the task loopback.
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',
        // Service identity — must match SPEC.md exactly for the query path.
        OTEL_RESOURCE_ATTRIBUTES:
          'service.name=checkout-service,deployment.environment=demo,service.version=1.0.0',
        AWS_REGION: this.region,
        // SSM parameter the app polls for the Act 4 fault flag (auto-generated name).
        FAULT_PARAM: faultParam.parameterName,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'app',
        logGroup,
      }),
    });

    // App HTTP port (/checkout, /admin/fault, /healthz).
    appContainer.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    // ---------------------------------------------------------------------
    // Container 2: OpenTelemetry Collector sidecar (upstream contrib)
    // ---------------------------------------------------------------------
    // Read the collector config at synth time (region-substituted above) and
    // pass it to the collector via the OTEL_CONFIG env var + `--config=env:`,
    // avoiding any need to bake or mount a config file.
    // Read the collector pipeline and substitute the deploy region so the OTLP
    // endpoint host + sigv4auth region follow `-c region=...`.
    const collectorConfig = fs
      .readFileSync(path.resolve(__dirname, '..', '..', 'otel', 'collector.yaml'), 'utf8')
      .replace(/us-east-1/g, this.region);

    const collectorContainer = taskDefinition.addContainer('CollectorContainer', {
      containerName: 'otel-collector',
      // Upstream OpenTelemetry Collector (contrib distro) — ships the otlphttp
      // exporter + sigv4auth extension this pipeline needs. Pulled from ghcr.io
      // (reliable unauthenticated Fargate pulls, multi-arch incl. arm64) and
      // pinned for reproducibility.
      image: ecs.ContainerImage.fromRegistry(
        'ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib:0.159.0',
      ),
      essential: true,
      // Upstream reads --config; load the inlined pipeline from an env var via
      // the `env:` config URI (no baked or mounted config file needed).
      command: ['--config=env:OTEL_CONFIG'],
      environment: {
        OTEL_CONFIG: collectorConfig,
        // sigv4auth uses the default AWS credential chain — on Fargate that's
        // the task-role creds from the ECS container credentials endpoint.
        AWS_REGION: this.region,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'collector',
        logGroup,
      }),
    });

    // OTLP receiver ports: gRPC 4317 and HTTP 4318 (per SPEC.md).
    collectorContainer.addPortMappings(
      { containerPort: 4317, protocol: ecs.Protocol.TCP },
      { containerPort: 4318, protocol: ecs.Protocol.TCP },
    );

    // ---------------------------------------------------------------------
    // Fargate service
    // ---------------------------------------------------------------------
    // awsvpc networking is implicit for Fargate. We place the task in the
    // VPC's public subnets with a public IP for egress (ECR pulls + the
    // CloudWatch OTLP endpoint). No inbound ports are opened.
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      // Single-task demo: allow the running task to drop to 0 during a
      // deployment so a replacement can start without needing 2x capacity.
      minHealthyPercent: 0,
      // Fail (and roll back) fast if a new task can't reach steady state,
      // instead of the default ~3h wait.
      circuitBreaker: { rollback: true },
    });

    // ---------------------------------------------------------------------
    // Act 4 (optional): auto-trigger a DevOps Agent investigation on breach
    // ---------------------------------------------------------------------
    // Closes the "no native CloudWatch-alarm auto-trigger" gap: when the
    // checkout-error-rate-slo PromQL alarm enters ALARM, an EventBridge rule
    // invokes a Lambda that HMAC-signs an incident payload and POSTs it to the
    // DevOps Agent generic webhook -- with a DynamoDB cooldown so a flapping
    // alarm cannot spawn a swarm of investigations.
    //
    // OPT-IN so collaborators can deploy the base demo without a DevOps Agent
    // webhook:   cdk deploy -c enableAutoTrigger=true \
    //              --parameters WebhookUrl=<url> --parameters WebhookSecret=<key>
    //
    // The URL + secret are supplied as NoEcho CloudFormation parameters and
    // written by CDK into a Secrets Manager secret at deploy time, so NO secret
    // material ever appears in source control or the synthesized template --
    // only a `{Ref}`. This makes the CDK safe to share and self-service.
    const enableAutoTrigger =
      `${this.node.tryGetContext('enableAutoTrigger')}` === 'true';

    if (enableAutoTrigger) {
      const webhookUrl = new CfnParameter(this, 'WebhookUrl', {
        type: 'String',
        noEcho: true,
        description:
          'AWS DevOps Agent generic webhook URL ' +
          '(https://event-ai.<region>.api.aws/webhook/generic/<id>). ' +
          'From the Agent Space -> Associations -> MCP Servers -> Webhook.',
      });
      const webhookSecret = new CfnParameter(this, 'WebhookSecret', {
        type: 'String',
        noEcho: true,
        description:
          'HMAC signing secret issued with the DevOps Agent webhook (shown once).',
      });

      // CDK writes both values into a JSON secret from the NoEcho parameters.
      // The template holds only { Ref: WebhookUrl } / { Ref: WebhookSecret }.
      const webhookSecretStore = new secretsmanager.Secret(this, 'DevOpsWebhookSecret', {
        description: '500 Bits demo: DevOps Agent webhook url + HMAC secret',
        secretObjectValue: {
          url: SecretValue.cfnParameter(webhookUrl),
          secret: SecretValue.cfnParameter(webhookSecret),
        },
        removalPolicy: RemovalPolicy.DESTROY,
      });

      new DevOpsAgentAutoTrigger(this, 'AutoTrigger', {
        alarmName: 'checkout-error-rate-slo',
        webhookSecret: webhookSecretStore,
        serviceName: 'checkout-service',
      });
    }

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'ECS cluster name',
    });

    new CfnOutput(this, 'ServiceName', {
      value: service.serviceName,
      description: 'Fargate service name',
    });

    new CfnOutput(this, 'LogGroupName', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Logs group for both containers',
    });

    new CfnOutput(this, 'FaultParameterName', {
      value: faultParam.parameterName,
      description: 'SSM parameter the app polls for the Act 4 fault flag',
    });
  }
}
