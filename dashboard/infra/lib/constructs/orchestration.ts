import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/** Durable outer run lifecycle. The worker owns the detailed task/group DAG. */
export class OrchestrationConstruct extends Construct {
  readonly queue: sqs.Queue;
  readonly callbacks: dynamodb.Table;
  readonly artifacts: s3.Bucket;
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const dlq = new sqs.Queue(this, 'DeadLetters', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
    this.queue = new sqs.Queue(this, 'Requests', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.minutes(2),
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      enforceSSL: true,
    });
    this.callbacks = new dynamodb.Table(this, 'Callbacks', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.artifacts = new s3.Bucket(this, 'Artifacts', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: cdk.Duration.days(2) }],
    });
    const dispatch = new tasks.SqsSendMessage(this, 'DispatchWorkflow', {
      queue: this.queue,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      heartbeatTimeout: sfn.Timeout.duration(cdk.Duration.minutes(5)),
      taskTimeout: sfn.Timeout.duration(cdk.Duration.days(7)),
      messageBody: sfn.TaskInput.fromObject({
        kind: 'workflow.start',
        workflowId: sfn.JsonPath.stringAt('$.workflowId'),
        token: sfn.JsonPath.taskToken,
        executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
      }),
      resultPath: '$.result',
    });
    const logGroup = new logs.LogGroup(this, 'ExecutionLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(dispatch.next(new sfn.Succeed(this, 'Finished'))),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.days(7),
      tracingEnabled: true,
      logs: { destination: logGroup, level: sfn.LogLevel.ERROR, includeExecutionData: false },
    });
    const terminalEvents = new events.Rule(this, 'ExecutionFailure', {
      eventPattern: {
        source: ['aws.states'],
        detailType: ['Step Functions Execution Status Change'],
        detail: { stateMachineArn: [this.stateMachine.stateMachineArn], status: ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'] },
      },
    });
    terminalEvents.addTarget(new targets.SqsQueue(this.queue, {
      message: events.RuleTargetInput.fromObject({
        kind: 'workflow.execution-ended',
        executionArn: events.EventField.fromPath('$.detail.executionArn'),
        status: events.EventField.fromPath('$.detail.status'),
      }),
    }));
  }
}
