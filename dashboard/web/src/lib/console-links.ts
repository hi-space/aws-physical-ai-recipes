/**
 * Deep links into the AWS Management Console for resources the dashboard reads. Only link shapes verified against the
 * current console are listed; a resource kind without a builder is shown as an identifier (copyable) with no link, which
 * is better than a link that lands on the wrong page.
 */
export type ConsoleResource =
  | { kind: 'hyperpod-cluster'; name: string }
  | { kind: 'eks-cluster'; name: string }
  | { kind: 's3-bucket'; bucket: string; prefix?: string }
  | { kind: 'fsx-filesystem'; id: string }
  | { kind: 'ec2-instance'; id: string }
  | { kind: 'amp-workspace'; id: string }
  | { kind: 'cognito-user-pool'; id: string }
  | { kind: 'dynamodb-table'; name: string }
  | { kind: 'log-group'; name: string }
  | { kind: 'training-job'; name: string }
  | { kind: 'iot-thing-group'; name: string }
  | { kind: 'cost-explorer' };

const base = (region: string, service: string) => `https://${region}.console.aws.amazon.com/${service}/home?region=${encodeURIComponent(region)}`;

export function consoleUrl(resource: ConsoleResource, region: string): string | undefined {
  switch (resource.kind) {
    case 'hyperpod-cluster': return `${base(region, 'sagemaker')}#/cluster-management/${encodeURIComponent(resource.name)}`;
    case 'eks-cluster': return `${base(region, 'eks')}#/clusters/${encodeURIComponent(resource.name)}`;
    case 's3-bucket': {
      const url = `https://${region}.console.aws.amazon.com/s3/buckets/${encodeURIComponent(resource.bucket)}?region=${encodeURIComponent(region)}`;
      return resource.prefix ? `${url}&prefix=${encodeURIComponent(resource.prefix)}` : url;
    }
    case 'fsx-filesystem': return `${base(region, 'fsx')}#file-system-details/${encodeURIComponent(resource.id)}`;
    case 'ec2-instance': return `${base(region, 'ec2')}#InstanceDetails:instanceId=${encodeURIComponent(resource.id)}`;
    case 'amp-workspace': return `${base(region, 'prometheus')}#/workspaces/workspace/${encodeURIComponent(resource.id)}`;
    case 'cognito-user-pool': return `https://${region}.console.aws.amazon.com/cognito/v2/idp/user-pools/${encodeURIComponent(resource.id)}/users?region=${encodeURIComponent(region)}`;
    case 'dynamodb-table': return `${base(region, 'dynamodbv2')}#table?name=${encodeURIComponent(resource.name)}`;
    // CloudWatch encodes the log group name twice: `/` → `%2F` → `$252F`.
    case 'log-group': return `${base(region, 'cloudwatch')}#logsV2:log-groups/log-group/${encodeURIComponent(encodeURIComponent(resource.name)).replace(/%/g, '$')}`;
    case 'training-job': return `${base(region, 'sagemaker')}#/jobs/${encodeURIComponent(resource.name)}`;
    case 'iot-thing-group': return `${base(region, 'iot')}#/thinggroup/${encodeURIComponent(resource.name)}`;
    case 'cost-explorer': return 'https://console.aws.amazon.com/costmanagement/home#/cost-explorer';
    default: return undefined;
  }
}
