import { describe, expect, it } from 'vitest';
import { consoleUrl } from './console-links';

describe('consoleUrl', () => {
  it('builds region-scoped links from the home region, never a fixed region', () => {
    expect(consoleUrl({ kind: 'hyperpod-cluster', name: 'hp-eks' }, 'us-west-2')).toBe('https://us-west-2.console.aws.amazon.com/sagemaker/home?region=us-west-2#/cluster-management/hp-eks');
    expect(consoleUrl({ kind: 'eks-cluster', name: 'eks-a' }, 'eu-west-1')).toBe('https://eu-west-1.console.aws.amazon.com/eks/home?region=eu-west-1#/clusters/eks-a');
    expect(consoleUrl({ kind: 'ec2-instance', id: 'i-0123456789abcdef0' }, 'us-east-1')).toContain('#InstanceDetails:instanceId=i-0123456789abcdef0');
    expect(consoleUrl({ kind: 'dynamodb-table', name: 'tbl' }, 'us-east-1')).toContain('dynamodbv2/home?region=us-east-1#table?name=tbl');
  });
  it('adds an S3 prefix only when given', () => {
    expect(consoleUrl({ kind: 's3-bucket', bucket: 'b' }, 'us-east-1')).toBe('https://us-east-1.console.aws.amazon.com/s3/buckets/b?region=us-east-1');
    expect(consoleUrl({ kind: 's3-bucket', bucket: 'b', prefix: 'datasets/' }, 'us-east-1')).toBe('https://us-east-1.console.aws.amazon.com/s3/buckets/b?region=us-east-1&prefix=datasets%2F');
  });
  it('double-encodes CloudWatch log group names the way the console expects', () => {
    expect(consoleUrl({ kind: 'log-group', name: '/aws/sagemaker/Clusters/hp' }, 'us-east-1')).toBe('https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/$252Faws$252Fsagemaker$252FClusters$252Fhp');
  });
  it('Cost Explorer is a global console page', () => {
    expect(consoleUrl({ kind: 'cost-explorer' }, 'ap-northeast-2')).toBe('https://console.aws.amazon.com/costmanagement/home#/cost-explorer');
  });
});
