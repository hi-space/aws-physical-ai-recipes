import { describe, expect, it } from 'vitest';
import { buildScaleSpec } from './hyperpod';
import { mlflowHeaders } from './mlflow';
import { METRICS } from './amp';

const groups = [
  { InstanceGroupName: 'cpu', InstanceType: 'ml.c5.4xlarge', CurrentCount: 1, TargetCount: 1, ExecutionRole: 'r', LifeCycleConfig: { SourceS3Uri: 's3://x', OnCreate: 'a.sh' }, ThreadsPerCore: 1 },
  { InstanceGroupName: 'gpu', InstanceType: 'ml.g5.8xlarge', CurrentCount: 0, TargetCount: 0, ExecutionRole: 'r', LifeCycleConfig: { SourceS3Uri: 's3://x', OnCreate: 'a.sh' } },
] as never[];

describe('buildScaleSpec', () => {
  it('changes only the target group', () => {
    const spec = buildScaleSpec(groups, 'gpu', 2);
    expect(spec.map((s) => [s.InstanceGroupName, s.InstanceCount])).toEqual([['cpu', 1], ['gpu', 2]]);
    expect(spec[0].ThreadsPerCore).toBe(1);
  });
  it('rejects unknown group and negative counts', () => {
    expect(() => buildScaleSpec(groups, 'nope', 1)).toThrow(/Unknown/);
    expect(() => buildScaleSpec(groups, 'gpu', -1)).toThrow(/non-negative/);
  });
});

describe('mlflow', () => {
  it('adds the SageMaker routing header', () => {
    expect(mlflowHeaders('arn:x')['x-mlflow-sm-tracking-server-arn']).toBe('arn:x');
  });
});

describe('METRICS allow-list', () => {
  it('escapes quotes in selectors', () => {
    expect(METRICS.gpu_util_pod({ pod: 'wf-"x"' })).not.toContain('"x"');
    expect(METRICS.pod_cpu({ pod: 'wf-abc.*', namespace: 'rl' })).toContain('namespace="rl"');
  });
});
