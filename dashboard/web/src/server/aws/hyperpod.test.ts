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

describe('node recovery and quota update requests', () => {
  it('rejects malformed or oversized node id sets before calling SageMaker', async () => {
    const { rebootNodes, replaceNodes } = await import('./hyperpod');
    await expect(rebootNodes('c', [])).rejects.toThrow(/Invalid node id set/);
    await expect(replaceNodes('c', ['node-1'])).rejects.toThrow(/Invalid node id set/);
    await expect(rebootNodes('c', Array.from({ length: 26 }, (_, i) => `i-${String(i).padStart(17, '0')}`))).rejects.toThrow(/Invalid node id set/);
  });
});
