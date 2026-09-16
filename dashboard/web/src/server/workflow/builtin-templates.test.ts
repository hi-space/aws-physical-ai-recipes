import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES, validateBuiltins } from './builtin-templates';
import { parseWorkflowYaml } from './template';
import { compileTask } from './compile';

describe('built-in templates', () => {
  it('all parse and validate with their defaults', () => {
    expect(validateBuiltins()).toEqual([]);
  });
  it('every declared param exists in default-values', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const { vars } = parseWorkflowYaml(t.yaml);
      for (const p of t.params) expect(vars, `${t.id}.${p.name}`).toHaveProperty(p.name);
    }
  });
  it('all tasks compile to Jobs', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const { spec } = parseWorkflowYaml(t.yaml);
      for (const task of spec.workflow.tasks) {
        const out = compileTask(spec, task, {
          workflowId: 'test0001',
          owner: 'u',
          namespace: 'rl',
          datasetPaths: { 'leisaac-pick-orange': '/fsx/datasets/leisaac-pick-orange/v1' },
          credentialValues: { huggingface: { HF_TOKEN: 'x' } },
        });
        expect((out.job as { kind: string }).kind).toBe('Job');
      }
    }
  });
  it('mujoco-train mirrors k8s-templates/rl/mujoco-train-job.yaml', () => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === 'mujoco-train')!;
    const { spec } = parseWorkflowYaml(t.yaml);
    const job = compileTask(spec, spec.workflow.tasks[0], { workflowId: 'w1', owner: 'u', namespace: 'rl', datasetPaths: {}, credentialValues: {} }).job as any;
    const c = job.spec.template.spec.containers[0];
    expect(c.image).toBe('public.ecr.aws/docker/library/python:3.11');
    expect(c.command[2]).toContain("'/fsx/envs/mujoco/bin/python' '/fsx/scratch/aws-physical-ai-recipes/hyperpod-training/examples/rl/train_mujoco.py' '--task' 'Workshop-SO101-Reach-MuJoCo-v0'");
    expect(c.resources.requests).toEqual({ cpu: '12', memory: '16Gi' });
    expect(job.spec.template.spec.nodeSelector['node.kubernetes.io/instance-type']).toBe('ml.c5.4xlarge');
    expect(c.env.find((e: { name: string }) => e.name === 'MUJOCO_MENAGERIE_DIR').value).toBe('/fsx/scratch/mujoco_menagerie');
  });
});
