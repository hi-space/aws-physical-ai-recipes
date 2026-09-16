import { describe, expect, it } from 'vitest';
import { parseWorkflowYaml } from './template';
import { compileTask, queueForNamespace, resolvePlaceholders } from './compile';
import { topoOrder, validateSpec } from './schema';

const YAML_TEXT = `
workflow:
  name: mujoco-reach
  namespace: rl
  timeout: { exec_timeout: 2h, queue_timeout: 1h }
  resources:
    cpu_train: { cpu: 12, memory: 16Gi, platform: ml.c5.4xlarge }
    gpu1: { cpu: 12, memory: 48Gi, gpu: 1, platform: ml.g5.8xlarge, shm_size: 8Gi }
  tasks:
    - name: setup
      resource: cpu_train
      image: python:3.11
      command: [bash, -lc, "echo setup"]
    - name: train
      resource: cpu_train
      image: public.ecr.aws/docker/library/python:3.11
      command: [bash, -lc]
      args: ["bash /tmp/entry.sh"]
      environment: { TOTAL_STEPS: "{{ total_steps }}", OUT: "{{output}}" }
      files:
        - path: /tmp/entry.sh
          contents: |
            echo train {{ total_steps }} to {{output}} from {{input:0}}
      inputs: [{ task: setup }, { dataset: { name: demos, path: /data } }]
      outputs: [{ dataset: { name: reach-ckpt, path: "{{output}}" } }]
      credentials: { hf: { HF_TOKEN: /groot/hf-token } }
      parallelism: 2
      retry: { max_retries: 1 }
    - name: play
      resource: gpu1
      image: nvcr.io/nvidia/isaac-lab:2.3.0
      command: [echo, hi]
      inputs: [{ task: train }]
      volumes: ["/tmp/.X11-unix:/tmp/.X11-unix"]
default-values:
  total_steps: "1000000"
`;

describe('parseWorkflowYaml', () => {
  it('substitutes default-values and overrides, keeps compiler placeholders', () => {
    const p = parseWorkflowYaml(YAML_TEXT, { total_steps: '5' });
    const train = p.spec.workflow.tasks[1];
    expect(train.environment.TOTAL_STEPS).toBe('5');
    expect(train.environment.OUT).toBe('{{output}}');
    expect(train.files[0].contents).toContain('{{input:0}}');
  });
  it('reports missing variables', () => {
    expect(() => parseWorkflowYaml(YAML_TEXT.replace('default-values:\n  total_steps: "1000000"\n', ''))).toThrow(/Missing template variables: total_steps/);
  });
  it('rejects unknown keys and bad references', () => {
    expect(() => parseWorkflowYaml(YAML_TEXT.replace('parallelism: 2', 'parallel: 2'))).toThrow(/Invalid workflow spec/);
    expect(() => parseWorkflowYaml(YAML_TEXT.replace('resource: gpu1', 'resource: nope'))).toThrow(/Invalid workflow spec/);
  });
  it('detects cycles', () => {
    const cyc = YAML_TEXT.replace('command: [bash, -lc, "echo setup"]', 'command: [bash]\n      inputs: [{ task: play }]');
    expect(() => parseWorkflowYaml(cyc)).toThrow(/cycle/);
  });
  it('orders topologically', () => {
    expect(topoOrder(parseWorkflowYaml(YAML_TEXT).spec)).toEqual(['setup', 'train', 'play']);
    expect(validateSpec(parseWorkflowYaml(YAML_TEXT).spec)).toEqual([]);
  });
});

describe('compileTask', () => {
  const { spec } = parseWorkflowYaml(YAML_TEXT);
  const ctx = {
    workflowId: 'abc123',
    owner: 'alice@example.com',
    namespace: 'hyperpod-ns-team-a',
    queue: 'hyperpod-ns-team-a-localqueue',
    priority: 'training-priority',
    datasetPaths: { demos: '/fsx/datasets/demos/v3' },
    credentialValues: { hf: { HF_TOKEN: 'hf_secret' } },
    mlflowTrackingUri: 'arn:aws:sagemaker:us-east-1:1:mlflow-tracking-server/x',
  };
  const train = compileTask(spec, spec.workflow.tasks[1], ctx);
  const job = train.job as any;
  const pod = job.spec.template.spec;
  const c = pod.containers[0];

  it('names and labels like render.sh with Kueue labels on job and pod', () => {
    expect(train.jobName).toBe('wf-abc123-train');
    expect(job.metadata.labels['kueue.x-k8s.io/queue-name']).toBe('hyperpod-ns-team-a-localqueue');
    expect(job.spec.template.metadata.labels['kueue.x-k8s.io/priority-class']).toBe('training-priority');
    expect(job.metadata.labels['pai.aws/owner']).toBe('alice_example.com');
  });
  it('sets resources, node selector and health-status selector', () => {
    expect(c.resources.requests).toEqual({ cpu: '12', memory: '16Gi' });
    expect(pod.nodeSelector).toEqual({ 'sagemaker.amazonaws.com/node-health-status': 'Schedulable', 'node.kubernetes.io/instance-type': 'ml.c5.4xlarge' });
  });
  it('mounts FSx, files ConfigMap, dataset subPath read-only', () => {
    expect(c.volumeMounts).toEqual(
      expect.arrayContaining([
        { name: 'fsx', mountPath: '/fsx' },
        { name: 'files', mountPath: '/pai/files', readOnly: true },
        { name: 'fsx', mountPath: '/data', subPath: 'datasets/demos/v3', readOnly: true },
      ]),
    );
    expect(train.configMap?.data['tmp_entry.sh']).toBe('echo train 1000000 to /fsx/checkpoints/workflows/abc123/train from /fsx/checkpoints/workflows/abc123/setup\n');
  });
  it('copies files then execs the user command', () => {
    expect(c.command[0]).toBe('/bin/sh');
    expect(c.command[2]).toContain("cp /pai/files/tmp_entry.sh '/tmp/entry.sh'");
    expect(c.command[2]).toContain("exec 'bash' '-lc' 'bash /tmp/entry.sh'");
  });
  it('injects env, mlflow and credentials via Secret', () => {
    const names = c.env.map((e: { name: string }) => e.name);
    expect(names).toEqual(expect.arrayContaining(['PAI_WORKFLOW_ID', 'OSMO_TASK_REPLICA_INDEX', 'MLFLOW_TRACKING_URI', 'TOTAL_STEPS', 'HF_TOKEN']));
    expect(c.env.find((e: { name: string }) => e.name === 'OUT').value).toBe('/fsx/checkpoints/workflows/abc123/train');
    expect(train.secret).toEqual({ name: 'wf-abc123-train-creds', data: { HF_TOKEN: 'hf_secret' } });
  });
  it('uses Indexed completion for parallelism and retries as backoffLimit', () => {
    expect(job.spec.completionMode).toBe('Indexed');
    expect(job.spec.completions).toBe(2);
    expect(job.spec.backoffLimit).toBe(1);
    expect(job.spec.activeDeadlineSeconds).toBe(7200);
    expect(job.spec.ttlSecondsAfterFinished).toBe(604800);
  });
  it('gpu task gets gpu limit, toleration, shm and x11 hostPath', () => {
    const play = compileTask(spec, spec.workflow.tasks[2], ctx).job as any;
    const ps = play.spec.template.spec;
    expect(ps.containers[0].resources.limits['nvidia.com/gpu']).toBe('1');
    expect(ps.tolerations[0].key).toBe('nvidia.com/gpu');
    expect(ps.volumes).toEqual(expect.arrayContaining([{ name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '8Gi' } }, { name: 'x11', hostPath: { path: '/tmp/.X11-unix', type: 'Directory' } }]));
  });
});

describe('helpers', () => {
  it('queueForNamespace mirrors render.sh', () => {
    expect(queueForNamespace('rl')).toBeUndefined();
    expect(queueForNamespace('hyperpod-ns-team-a')).toBe('hyperpod-ns-team-a-localqueue');
    expect(queueForNamespace('rl', 'myq')).toBe('myq');
    expect(queueForNamespace('hyperpod-ns-team-a', 'none')).toBeUndefined();
  });
  it('resolvePlaceholders', () => {
    expect(resolvePlaceholders('{{ output }}/{{input:1}}', { output: '/o', inputs: ['/a', '/b'], workflowId: 'w', taskName: 't' })).toBe('/o//b');
  });
});
