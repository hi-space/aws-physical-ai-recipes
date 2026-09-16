import { expect, it } from 'vitest';
import { parseWorkflowYaml } from './template';
import { compileTask } from './compile';
import { checkpointSources, checkpointURL, type RecoveryTask } from './checkpoints';
import type { Workflow } from '../store/types';

const yaml = `workflow:
  name: recovery
  resources: { cpu: { cpu: 1 } }
  tasks:
    - name: train
      resource: cpu
      image: python
      command: [python, train.py]
      retry: { max_retries: 1 }
      exitActions: { COMPLETE: 0, RESCHEDULE: 75 }
      checkpoint: [{path: '{{output}}', url: auto, frequency: 30s}]
`;

it('accepts auto checkpoints and compiles resolved paths/destinations plus restore startup flag', () => {
  const { spec } = parseWorkflowYaml(yaml);
  const compiled = compileTask(spec, spec.workflow.tasks[0], {
    workflowId: 'run', projectId: 'p', namespace: 'n', owner: 'a', attempt: 2,
    datasetPaths: {}, credentialValues: {}, runtimeCommand: '/opt/pai/runtime', runtimeImage: 'runtime:test',
    artifactBucket: 'artifacts', checkpointRestore: true,
  });
  const command = (compiled.job as any).spec.template.spec.containers[0].command.join(' ');
  expect(command).toContain('"checkpointRestore":true');
  expect(command).toContain('"path":"/fsx/checkpoints/projects/p/runs/run/attempts/2/train"');
  expect(command).toContain('s3://artifacts/projects/p/runs/run/checkpoints/train/0/');
});

it('keeps explicit S3 destinations and rejects unconfigured auto destinations', () => {
  const checkpoint = { path: '/checkpoint', url: 's3://artifacts/projects/p/user/', frequency: '1s' };
  expect(checkpointURL(checkpoint, 0, { workflowId: 'r', task: 'train' })).toBe(checkpoint.url);
  expect(() => checkpointURL({ ...checkpoint, url: 'auto' }, 0, { workflowId: 'r', task: 'train' })).toThrow(/project/);
});

it('preserves previous server-owned attempts in newest-first order without reusing credentials', () => {
  const source = { workflowId: 'older', task: 'train', attempt: 3, epoch: 'old-epoch' };
  const task = { name: 'train', attempts: 2, attemptEpoch: 'epoch-2', checkpointRestoreSources: [source] } as RecoveryTask;
  expect(checkpointSources({ id: 'current' } as Workflow, task)).toEqual([
    { workflowId: 'current', task: 'train', attempt: 2, epoch: 'epoch-2' }, source,
  ]);
});
