import * as path from 'path';
import { Construct } from 'constructs';
import { Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface DevOpsAgentAutoTriggerProps {
  /**
   * The CloudWatch alarm name to auto-investigate. The EventBridge rule matches
   * ONLY this alarm entering ALARM state, so unrelated alarms in the account are
   * never forwarded.
   */
  readonly alarmName: string;

  /**
   * Secrets Manager secret holding the DevOps Agent webhook credentials as a
   * JSON object: {"url": "<generic webhook url>", "secret": "<hmac secret>"}.
   *
   * The value is supplied at deploy time via NoEcho CloudFormation parameters
   * (see FiveHundredBitsStack), so the URL/secret never land in source control
   * or the CFN template -- only a `{Ref}` does.
   */
  readonly webhookSecret: secretsmanager.ISecret;

  /**
   * `service` field sent on the incident payload. Defaults to 'checkout-service'.
   */
  readonly serviceName?: string;

  /**
   * De-dup cooldown: at most one investigation per alarm per this window.
   * Defaults to 30 minutes.
   */
  readonly cooldown?: Duration;

  /**
   * Priority sent to the agent (CRITICAL|HIGH|MEDIUM|LOW|MINIMAL). Default HIGH.
   */
  readonly priority?: string;
}

/**
 * DevOpsAgentAutoTrigger
 *
 * Closes the "no native CloudWatch-alarm auto-trigger" gap for AWS DevOps Agent:
 *
 *   CloudWatch alarm (ALARM) --> EventBridge rule --> Lambda --> DevOps Agent
 *                                                       |  generic webhook
 *                                                       +--> DynamoDB (cooldown dedup)
 *
 * The Lambda signs the incident payload (HMAC-SHA256) and POSTs it to the Agent
 * Space webhook, but only after claiming a per-alarm cooldown slot in DynamoDB,
 * so a flapping alarm cannot spawn a swarm of investigations. The webhook URL +
 * secret are read at runtime from Secrets Manager.
 */
export class DevOpsAgentAutoTrigger extends Construct {
  public readonly fn: lambda.Function;
  public readonly rule: events.Rule;
  public readonly dedupTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DevOpsAgentAutoTriggerProps) {
    super(scope, id);

    const cooldown = props.cooldown ?? Duration.minutes(30);

    // -------------------------------------------------------------------
    // Dedup table: one row per alarm, TTL on `expiresAt`.
    // -------------------------------------------------------------------
    this.dedupTable = new dynamodb.Table(this, 'DedupTable', {
      partitionKey: { name: 'alarmName', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      // Demo resource — tear down cleanly with the stack.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // -------------------------------------------------------------------
    // Lambda: EventBridge target that signs + POSTs the incident.
    // -------------------------------------------------------------------
    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.resolve(__dirname, '..', 'lambda', 'alarm-to-devops-agent'),
      ),
      timeout: Duration.seconds(30),
      memorySize: 128,
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        DEDUP_TABLE: this.dedupTable.tableName,
        WEBHOOK_SECRET_ARN: props.webhookSecret.secretArn,
        COOLDOWN_SECONDS: String(cooldown.toSeconds()),
        DEFAULT_PRIORITY: props.priority ?? 'HIGH',
        SERVICE_NAME: props.serviceName ?? 'checkout-service',
        ALARM_ALLOWLIST: props.alarmName,
      },
    });

    this.dedupTable.grantReadWriteData(this.fn);
    // Read the webhook URL + secret at runtime (secretsmanager:GetSecretValue,
    // scoped to this secret only). Decryption uses the account-default
    // `aws/secretsmanager` KMS key, which needs no explicit grant same-account.
    props.webhookSecret.grantRead(this.fn);

    // -------------------------------------------------------------------
    // EventBridge rule: THIS alarm entering ALARM only.
    // -------------------------------------------------------------------
    this.rule = new events.Rule(this, 'AlarmRule', {
      description: `Auto-trigger DevOps Agent investigation when ${props.alarmName} enters ALARM`,
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        detail: {
          alarmName: [props.alarmName],
          state: { value: ['ALARM'] },
        },
      },
    });
    this.rule.addTarget(
      new targets.LambdaFunction(this.fn, {
        retryAttempts: 2,
      }),
    );

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------
    new CfnOutput(this, 'TriggerFunctionName', {
      value: this.fn.functionName,
      description: 'Lambda that forwards alarm breaches to the DevOps Agent webhook',
    });
    new CfnOutput(this, 'DedupTableName', {
      value: this.dedupTable.tableName,
      description: 'DynamoDB table enforcing the per-alarm investigation cooldown',
    });
  }
}
