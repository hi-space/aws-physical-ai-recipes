import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES, getRecipeMetadata, materializeBuiltinTemplate, recipeConfigurationErrors, seedBuiltinTemplates, validateBuiltins } from './builtin-templates';
import { parseWorkflowYaml, readDefaults } from './template';
import { compileTask, outputPathFor } from './compile';
import { compileGroup } from './groups';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Repo, setRepoForTests } from '../store/repo';
import { MemoryKV } from '../store/dynamo';

const configured = (id: string, run = 'test-run-a') => {
  const template = BUILTIN_TEMPLATES.find(t => t.id === id)!;
  const overrides = Object.fromEntries(template.params.filter(p => p.name.endsWith('image') || p.name === 'image')
    .map(p => [p.name, 'localhost:5000/verified-recipe@sha256:' + 'a'.repeat(64)]));
  return parseWorkflowYaml(materializeBuiltinTemplate(template, run), overrides);
};
const context = {
  workflowId: 'test-run-a', projectId: 'research', owner: 'researcher', namespace: 'rl', attempt: 2,
  artifactBucket: 'validated-artifacts',
  datasetPaths: {}, credentialValues: { huggingface: { HF_TOKEN: 'test-token' } },
  runtimeImage: 'localhost:5000/runtime@sha256:' + 'b'.repeat(64),
  runtimeEnvironment: { PAI_RUNTIME_ENDPOINT: 'http://controller/runtime', PAI_RUNTIME_TOKEN: 'fixture' },
  mlflowTrackingUri: 'arn:aws:sagemaker:us-east-1:123456789012:mlflow-tracking-server/test',
};

describe('researcher recipe catalog', () => {
  it('provides Korean researcher descriptions, parameter labels/help, and prerequisite explanations', () => {
    for (const template of BUILTIN_TEMPLATES) {
      expect(template.description, template.id).toMatch(/[가-힣]/);
      for (const param of template.params) {
        expect(param.label, `${template.id}.${param.name}`).toMatch(/[가-힣]/);
        if (param.help) expect(param.help, `${template.id}.${param.name}.help`).toMatch(/[가-힣]/);
      }
      for (const prerequisite of getRecipeMetadata(template).prerequisites) expect(prerequisite.reason, `${template.id}.${prerequisite.kind}`).toMatch(/[가-힣]/);
    }
  });
  it('includes the approved workload families', () => {
    for (const id of ['mujoco-pipeline', 'isaaclab-train', 'isaaclab-h1', 'gr00t-finetune', 'replicator-sdg', 'ros2-transfer', 'openpi-train', 'mimic-pipeline', 'cosmos-pipeline', 'leisaac-evaluate']) {
      expect(BUILTIN_TEMPLATES.map(t => t.id)).toContain(id);
    }
  });
  it('parses and semantically validates every recipe after binding the run identity', () => {
    expect(validateBuiltins()).toEqual([]);
    for (const t of BUILTIN_TEMPLATES) {
      const { spec } = configured(t.id);
      expect(spec.workflow.tasks.length).toBeGreaterThan(0);
      const vars = readDefaults(t.yaml);
      for (const p of t.params) expect(vars, `${t.id}.${p.name}`).toHaveProperty(p.name);
    }
  });
  it('compiles every real task and concurrent group with the parent runtime', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const { spec } = configured(t.id);
      const ctx = { ...context, datasetPaths: Object.fromEntries(spec.workflow.tasks.flatMap(task =>
        task.inputs.flatMap(input => 'dataset' in input
          ? [[input.dataset.name, `/fsx/datasets/projects/research/${input.dataset.name}/v1`]]
          : []))) };
      for (const task of spec.workflow.tasks) {
        if (task.group) continue; // peers can only be resolved with their actual group context
        const compiled = compileTask(spec, task, ctx);
        const job = compiled.job as any;
        expect(job.kind).toBe('Job');
        expect(job.spec.template.spec.containers[0].image).toContain('/verified-recipe@sha256:');
        expect(job.spec.template.spec.initContainers.some((c: any) => c.image === context.runtimeImage)).toBe(true);
        expect(compiled.outputPath).toBe(outputPathFor(context.workflowId, task.name, 2, context.projectId));
      }
      for (const group of spec.workflow.groups ?? []) {
        const compiled = compileGroup(spec, group, ctx, 'epoch-2');
        expect(compiled.jobSet.kind).toBe('JobSet');
        expect(compiled.jobSet.spec.replicatedJobs).toHaveLength(group.tasks.length);
        expect(group.tasks.filter(t => t.lead)).toHaveLength(1);
        expect(group.ignoreNonleadStatus).toBe(false);
        expect(JSON.stringify(compiled.jobSet)).not.toContain('{{host:');
        if (t.id === 'ros2-transfer' || t.id === 'leisaac-evaluate') {
          expect(JSON.stringify(compiled.jobSet)).toContain('.rl.svc.cluster.local');
        }
      }
    }
  });
  it('keeps each publication inside task output and names datasets uniquely per run', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const first = configured(t.id, 'run-a').spec.workflow.tasks.flatMap(t => t.outputs);
      const second = configured(t.id, 'run-b').spec.workflow.tasks.flatMap(t => t.outputs);
      expect(first.length).toBeGreaterThan(0);
      first.forEach((output, i) => {
        expect('dataset' in output ? output.dataset.path : output.logs).toMatch(/^\{\{output\}\}(\/|$)/);
        if ('dataset' in output && 'dataset' in second[i]) {
          expect(output.dataset.name).toMatch(/-run-a$/);
          expect(output.dataset.name).not.toBe(second[i].dataset.name);
        }
      });
    }
  });
  it('passes the exact trained bundle to CPU evaluation across attempts', () => {
    const { spec } = configured('mujoco-pipeline');
    const training = compileTask(spec, spec.workflow.tasks[0], context);
    const evaluation = spec.workflow.tasks.find(t => t.name === 'evaluate')!;
    expect(evaluation.inputs).toEqual([{ task: 'train' }]);
    const job = compileTask(spec, evaluation, { ...context, taskOutputPaths: { train: training.outputPath } }).job as any;
    const command = JSON.stringify(job.spec.template.spec.containers[0]);
    expect(command).toContain(`${training.outputPath}/final`);
    expect(command).toContain('/opt/recipes/mujoco/evaluate.py');
    expect(command).toContain('--output-dir');
  });
  it('requires real provisioning and preserves sources for every workload', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const metadata = getRecipeMetadata(t);
      expect(metadata.sources.length).toBeGreaterThan(0);
      expect(metadata.imageContract).toContain('Dockerfile');
      expect(metadata.prerequisites.some(p => p.kind === 'image')).toBe(true);
      if (metadata.verification !== 'local-docker') {
        expect(metadata.readiness).toBe('prerequisites-required');
        expect(t.description).toMatch(/^준비 사항을 확인하세요/);
      }
      const defaults = readDefaults(t.yaml);
      const unset = Object.fromEntries(metadata.prerequisites.filter(p => p.kind === 'image').map(p => [p.parameter!, '']));
      expect(recipeConfigurationErrors(t, { ...defaults, ...unset }).length).toBeGreaterThan(0);
      expect(t.yaml).not.toContain('913524902871.dkr.ecr');
    }
  });
  it('enables actual MLflow adapters and resume on Isaac Lab and GR00T', () => {
    for (const id of ['isaaclab-train', 'isaaclab-h1', 'gr00t-finetune']) {
      const { spec } = configured(id);
      expect(spec.workflow.mlflow).toBe(true);
      const task = spec.workflow.tasks[0];
      expect(task.args).toContain('--resume');
      expect(task.args).toContain('--seed');
      const ctx = { ...context, datasetPaths: Object.fromEntries(task.inputs.flatMap(input => 'dataset' in input
        ? [[input.dataset.name, `/fsx/datasets/projects/research/${input.dataset.name}/v1`]] : [])) };
      const job = compileTask(spec, task, ctx).job as any;
      expect(job.spec.template.spec.containers[0].env).toContainEqual({ name: 'MLFLOW_TRACKING_URI', value: context.mlflowTrackingUri });
    }
  });
  it('never executes unfinished examples or mutates a shared checkout', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const { spec } = configured(t.id);
      const commands = spec.workflow.tasks.map(t => [...(t.command ?? []), ...(t.args ?? [])].join(' ')).join('\n');
      expect(commands).not.toMatch(/train_pi0\.py|eval_closed_loop\.py|\/fsx\/scratch|\/fsx\/envs|pip install|apt-get|git clone|git reset/);
    }
  });
});

describe('two-rank CPU Torch/Gloo recipe', () => {
  it('compiles one barrier-protected Indexed Job with two eight-core replicas and rank-0 DNS', () => {
    const template = BUILTIN_TEMPLATES.find(t => t.id === 'torch-gloo-2rank');
    expect(template).toBeDefined();
    const { spec } = configured('torch-gloo-2rank');
    const group = spec.workflow.groups![0];
    expect(group).toMatchObject({ name: 'gloo', barrier: true, ignoreNonleadStatus: false });
    expect(group.tasks).toHaveLength(1);
    expect(group.tasks[0]).toMatchObject({ name: 'train', parallelism: 2, lead: true });
    const compiled = compileGroup(spec, group, { ...context, queue: 'research-localqueue' }, 'epoch-gloo');
    const child = compiled.jobSet.spec.replicatedJobs[0].template.spec;
    expect(compiled.jobSet.spec.suspend).toBe(true);
    expect(child).toMatchObject({ completionMode: 'Indexed', completions: 2, parallelism: 2, backoffLimit: 0 });
    expect(child.template.spec.nodeSelector?.['node.kubernetes.io/instance-type']).toBe('ml.c5.4xlarge');
    const container = child.template.spec.containers[0];
    expect(container.resources?.requests?.cpu).toBe('8');
    expect(container.resources?.limits).not.toHaveProperty('nvidia.com/gpu');
    expect(container.resources?.limits).not.toHaveProperty('vpc.amazonaws.com/efa');
    expect(container.env).toContainEqual({ name: 'MASTER_ADDR', value: `${compiled.jobSet.metadata.name}-train-0-0.${compiled.jobSet.metadata.name}.rl.svc.cluster.local` });
    expect(container.env).toContainEqual({ name: 'PAI_REPLICA_INDEX', valueFrom: { fieldRef: { fieldPath: "metadata.annotations['batch.kubernetes.io/job-completion-index']" } } });
    expect(container.command?.join(' ')).toContain('"members":["train:0","train:1"]');
    expect(compiled.tasks[0].configMap?.data).toBeDefined();
    expect(spec.workflow.tasks[0].outputs).toEqual([{ dataset: { name: 'torch-gloo-test-run-a', path: '{{output}}' } }]);
    expect(template!.requires).not.toContain('gpu');
    expect(getRecipeMetadata(template!)).toMatchObject({ readiness: 'prerequisites-required', verification: 'source-verified-network-unverified', evaluationType: 'training_only' });
  });

  // Opt-in local computation only. Ordinary catalog tests need no Python/Torch installation.
  it.skipIf(process.env.PAI_DISTRIBUTED_LOCAL !== '1')('trains two real local CPU ranks and verifies collective results, model tensors and artifact digests', async () => {
    const { spec } = configured('torch-gloo-2rank');
    const script = spec.workflow.tasks[0].files.find(file => file.path === '/tmp/torch_gloo_train.py')!;
    expect(script).toBeDefined();
    const directory = await mkdtemp(join(tmpdir(), 'pai-gloo-local-'));
    const output = join(directory, 'output'), path = join(directory, 'train.py');
    await mkdir(output); await writeFile(path, script.contents);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const execute = promisify(execFile), python = process.env.PAI_DISTRIBUTED_PYTHON ?? 'python3';
    try {
      await Promise.all([0, 1].map(rank => execute(python, [path, '--steps', '8', '--observe-seconds', '0'], {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', MASTER_ADDR: '127.0.0.1', MASTER_PORT: String(port), WORLD_SIZE: '2', GLOO_SOCKET_IFNAME: 'lo',
          PAI_WORKFLOW_ID: 'local-gloo', PAI_TASK_NAME: 'train', PAI_TASK_REPLICAS: '2', PAI_REPLICA_INDEX: String(rank), OSMO_TASK_REPLICA_INDEX: String(rank), JOB_COMPLETION_INDEX: String(rank),
          PAI_ATTEMPT: '1', PAI_ATTEMPT_EPOCH: 'local-epoch', PAI_OUTPUT_DIR: output },
        timeout: 45000, maxBuffer: 256 * 1024,
      })));
      for (const rank of [0, 1]) {
        const proof = JSON.parse(await readFile(join(output, `rank-${rank}/proof.json`), 'utf8'));
        const weightsBytes = await readFile(join(output, `rank-${rank}/weights.json`));
        const modelBytes = await readFile(join(output, `rank-${rank}/model.pt`));
        expect(proof).toMatchObject({ rank, replicaIndex: rank, worldSize: 2, backend: 'gloo', device: 'cpu', runId: 'local-gloo', taskName: 'train',
          observedRanks: [0, 1], localContribution: rank + 1, allReduceSum: 3, firstAveragedGradient: -10, steps: 8, initialLoss: 10 });
        expect(proof.finalWeight).toBeCloseTo(1.9921875, 12);
        expect(proof.finalLoss).toBeCloseTo(10 / 65536, 12);
        expect(proof.gatheredWeights).toEqual([proof.finalWeight, proof.finalWeight]);
        expect(proof.modelSha256).toBe(createHash('sha256').update(modelBytes).digest('hex'));
        expect(proof.weightsSha256).toBe(createHash('sha256').update(weightsBytes).digest('hex'));
        expect(JSON.parse(weightsBytes.toString()).state_dict.weight[0][0]).toBe(proof.finalWeight);
      }
      const loaded = await execute(python, ['-c', 'import json,sys,torch; print(json.dumps([float(torch.load(p,weights_only=True,map_location=\"cpu\")[\"weight\"].item()) for p in sys.argv[1:]]))', join(output, 'rank-0/model.pt'), join(output, 'rank-1/model.pt')], { timeout: 20000, maxBuffer: 64 * 1024 });
      expect(JSON.parse(loaded.stdout)).toEqual([1.9921875, 1.9921875]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60000);
});

it('archives the incompatible legacy GR00T pipeline without removing its immutable source revision', async () => {
  const repo = new Repo(new MemoryKV());
  setRepoForTests(repo);
  const original = { ...BUILTIN_TEMPLATES.find(template => template.id === 'custom')!, id: 'gr00t-pipeline', description: 'Legacy mutable FSx/direct-AWS flow' };
  // Simulate the original pre-revision registry, not an already migrated template.
  await repo.kv.put({ pk: 'TPL#gr00t-pipeline', sk: 'META', gsi1pk: 'TYPE#TPL', gsi1sk: '0#Legacy GR00T', ...original });
  await seedBuiltinTemplates();
  expect(await repo.getTemplate('gr00t-pipeline')).toBeUndefined();
  expect(await repo.getTemplate('gr00t-pipeline', 1)).toMatchObject({ yaml: original.yaml, description: original.description });
  await seedBuiltinTemplates();
  expect(await repo.listTemplateVersions('gr00t-pipeline')).toHaveLength(1);
  expect(BUILTIN_TEMPLATES.some(template => template.id === 'gr00t-pipeline')).toBe(false);
});
