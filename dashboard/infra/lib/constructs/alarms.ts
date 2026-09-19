import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface AlarmsConstructProps {
  namePrefix: string;
  loadBalancer: elbv2.ApplicationLoadBalancer;
  controllerService: ecs.FargateService;
  clusterName: string;
  /** Omit to skip the WAF blocked-request alarm (WAF module disabled). */
  webAclName?: string;
  topic: sns.ITopic;
}

// Starting thresholds; tune from observed baselines.
const TARGET_5XX_PERCENT = 5;
const TARGET_P99_SECONDS = 5;
const RECONCILE_LAG_SECONDS = 60;
const WAF_BLOCKED_PER_5MIN = 500;

type AlarmOptions = Partial<Omit<cloudwatch.CreateAlarmOptions, 'threshold' | 'evaluationPeriods'>> &
  Pick<cloudwatch.CreateAlarmOptions, 'threshold' | 'evaluationPeriods'>;

/** Operational alarms → the dashboard notifications topic. */
export class AlarmsConstruct extends Construct {
  constructor(scope: Construct, id: string, props: AlarmsConstructProps) {
    super(scope, id);
    const minute = cdk.Duration.minutes(1);
    const action = new cwActions.SnsAction(props.topic);
    const alarm = (name: string, metric: cloudwatch.IMetric, options: AlarmOptions) => {
      const created = new cloudwatch.Alarm(this, name, {
        alarmName: `${props.namePrefix}-${name}`,
        metric,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...options,
      });
      created.addAlarmAction(action);
      return created;
    };

    const requests = props.loadBalancer.metrics.requestCount({ period: minute, statistic: 'Sum' });
    const errors = props.loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: minute, statistic: 'Sum' });
    alarm('AlbTarget5xx', new cloudwatch.MathExpression({
      expression: 'IF(requests > 0, 100 * errors / requests, 0)',
      usingMetrics: { requests, errors },
      period: minute,
      label: 'target 5xx %',
    }), { threshold: TARGET_5XX_PERCENT, evaluationPeriods: 5, datapointsToAlarm: 3, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD });

    alarm('AlbTargetLatency', props.loadBalancer.metrics.targetResponseTime({ period: minute, statistic: 'p99' }),
      { threshold: TARGET_P99_SECONDS, evaluationPeriods: 5, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD });

    alarm('ControllerReconcileLag', new cloudwatch.Metric({
      namespace: 'PhysicalAI/Dashboard', metricName: 'ReconcileLagSeconds', dimensionsMap: { Service: 'controller' }, statistic: 'Maximum', period: minute,
    }), { threshold: RECONCILE_LAG_SECONDS, evaluationPeriods: 2, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.BREACHING });

    alarm('ControllerRunningTasks', new cloudwatch.Metric({
      namespace: 'ECS/ContainerInsights', metricName: 'RunningTaskCount',
      dimensionsMap: { ClusterName: props.clusterName, ServiceName: props.controllerService.serviceName }, statistic: 'Minimum', period: minute,
    }), { threshold: 1, evaluationPeriods: 3, comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.BREACHING });

    if (props.webAclName) {
      alarm('WafBlockedSpike', new cloudwatch.Metric({
        namespace: 'AWS/WAFV2', metricName: 'BlockedRequests',
        dimensionsMap: { WebACL: props.webAclName, Region: cdk.Stack.of(this).region, Rule: 'ALL' }, statistic: 'Sum', period: cdk.Duration.minutes(5),
      }), { threshold: WAF_BLOCKED_PER_5MIN, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD });
    }
  }
}
