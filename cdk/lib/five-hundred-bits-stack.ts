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
 *   - a VPC (2 AZs, single NAT gateway)
 *   - an ECS cluster
 *   - a single Fargate task running TWO containers:
 *       1. the "checkout-service" app (built from ../app) on port 8080
 *          with an internal load generator, exporting OTLP/gRPC to
 *          localhost:4317
 *       2. an ADOT collector sidecar that receives OTLP on 4317/4318 and
 *          exports metrics to the CloudWatch OTLP metrics endpoint
 *
 * All names, ports, endpoints, and resource attributes are dictated by
 * SPEC.md (the canonical demo contract).
 */
export class FiveHundredBitsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

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
      containerInsights: true,
    });

    // ---------------------------------------------------------------------
    // Shared log group for both containers (awslogs driver)
    // ---------------------------------------------------------------------
    // SPEC.md fixes the log group name; ONE_WEEK retention keeps demo logs
    // cheap and disposable. DESTROY removal policy ensures the log group is
    // deleted on stack teardown/rollback rather than orphaned — otherwise the
    // fixed name collides (NAME_CONFLICT) on the next create.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/ecs/500-bits-to-impact',
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

    // The TASK ROLE is the identity the running containers assume. The ADOT
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
    const faultParam = new ssm.StringParameter(this, 'FaultFlag', {
      parameterName: '/500bits/fault',
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
        AWS_REGION: 'us-east-1',
        // SSM parameter the app polls for the Act 4 fault flag.
        FAULT_PARAM: '/500bits/fault',
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
    // Container 2: ADOT collector sidecar
    // ---------------------------------------------------------------------
    // Read the collector config at synth time and inline it via the
    // AOT_CONFIG_CONTENT environment variable — the AWS OTel Collector image
    // loads its pipeline from this variable when set, avoiding any need to
    // bake or mount a config file.
    const collectorConfig = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'otel', 'collector.yaml'),
      'utf8',
    );

    const collectorContainer = taskDefinition.addContainer('CollectorContainer', {
      containerName: 'aws-otel-collector',
      image: ecs.ContainerImage.fromRegistry(
        'public.ecr.aws/aws-observability/aws-otel-collector:latest',
      ),
      essential: true,
      environment: {
        // Inlined collector pipeline (OTLP receivers -> CloudWatch OTLP export).
        AOT_CONFIG_CONTENT: collectorConfig,
        AWS_REGION: 'us-east-1',
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
  }
}
