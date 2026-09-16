import { config } from '../config';
import { managedLabels } from '../k8s/resources';
import { durationToSeconds, type ResourceSpec, type TaskSpec, type WorkflowSpec } from './schema';

export const LABEL_WF = 'pai.aws/workflow-id';
export const LABEL_TASK = 'pai.aws/task';
export const LABEL_OWNER = 'pai.aws/owner';

export interface CompileContext {
  workflowId: string;
  owner: string;
  namespace: string;
  queue?: string; // Kueue LocalQueue name or undefined
  priority?: string;
  /** dataset name → resolved FSx path (for inputs) */
  datasetPaths: Record<string, string>;
  /** credential name → {ENV: value} resolved from SSM */
  credentialValues: Record<string, Record<string, string>>;
  mlflowTrackingUri?: string;
  /** ServiceAccount bound to the workflow-pods IAM role via EKS Pod Identity (S3 export, MLflow logging). */
  serviceAccountName?: string;
}

export interface CompiledTask {
  jobName: string;
  job: Record<string, unknown>;
  configMap?: { name: string; data: Record<string, string> };
  secret?: { name: string; data: Record<string, string> };
  outputPath: string;
}

export function outputPathFor(workflowId: string, task: string): string {
  return `/fsx/checkpoints/workflows/${workflowId}/${task}`;
}

export function jobNameFor(workflowId: string, task: string): string {
  return `wf-${workflowId}-${task}`.slice(0, 63).replace(/-+$/, '');
}

/** Resolve the Kueue LocalQueue for a namespace, mirroring render.sh. */
export function queueForNamespace(ns: string, explicit?: string): string | undefined {
  if (explicit && explicit !== 'auto') return explicit === 'none' ? undefined : explicit;
  return ns.startsWith('hyperpod-ns-') ? `${ns}-localqueue` : undefined;
}

const cmToKey = (p: string) => p.replace(/^\//, '').replace(/[^A-Za-z0-9._-]/g, '_');

export function resolvePlaceholders(text: string, ctx: { output: string; inputs: string[]; workflowId: string; taskName: string }): string {
  return text
    .replace(/\{\{\s*output\s*\}\}/g, ctx.output)
    .replace(/\{\{\s*workflow_id\s*\}\}/g, ctx.workflowId)
    .replace(/\{\{\s*task_name\s*\}\}/g, ctx.taskName)
    .replace(/\{\{\s*input:(\d+)\s*\}\}/g, (_m, i: string) => ctx.inputs[Number(i)] ?? `/fsx/checkpoints/workflows/${ctx.workflowId}/__missing_input_${i}`);
}

export function compileTask(spec: WorkflowSpec, task: TaskSpec, ctx: CompileContext): CompiledTask {
  const wf = spec.workflow;
  const res: ResourceSpec = wf.resources[task.resource] ?? {};
  const jobName = jobNameFor(ctx.workflowId, task.name);
  const output = outputPathFor(ctx.workflowId, task.name);
  const inputPaths = task.inputs.map((i) => ('task' in i ? outputPathFor(ctx.workflowId, i.task) : (i.dataset.path ?? ctx.datasetPaths[i.dataset.name] ?? `/fsx/datasets/${i.dataset.name}`)));
  const ph = { output, inputs: inputPaths, workflowId: ctx.workflowId, taskName: task.name };
  const R = (s: string) => resolvePlaceholders(s, ph);

  const labels = managedLabels({ [LABEL_WF]: ctx.workflowId, [LABEL_TASK]: task.name, [LABEL_OWNER]: sanitizeLabel(ctx.owner) });
  const kueueLabels: Record<string, string> = {};
  if (ctx.queue) kueueLabels['kueue.x-k8s.io/queue-name'] = ctx.queue;
  if (ctx.queue && ctx.priority) kueueLabels['kueue.x-k8s.io/priority-class'] = ctx.priority;

  const env: { name: string; value?: string; valueFrom?: unknown }[] = [
    { name: 'PAI_WORKFLOW_ID', value: ctx.workflowId },
    { name: 'PAI_TASK_NAME', value: task.name },
    { name: 'PAI_OUTPUT_DIR', value: output },
    { name: 'OSMO_WORKFLOW_ID', value: ctx.workflowId },
    { name: 'OSMO_TASK_NAME', value: task.name },
    { name: 'OSMO_TASK_REPLICAS', value: String(task.parallelism) },
    { name: 'OSMO_TASK_REPLICA_INDEX', valueFrom: { fieldRef: { fieldPath: "metadata.annotations['batch.kubernetes.io/job-completion-index']" } } },
    { name: 'PYTHONUNBUFFERED', value: '1' },
  ];
  if (ctx.mlflowTrackingUri) {
    env.push({ name: 'MLFLOW_TRACKING_URI', value: ctx.mlflowTrackingUri }, { name: 'MLFLOW_EXPERIMENT_NAME', value: wf.name }, { name: 'MLFLOW_RUN_NAME', value: `${ctx.workflowId}/${task.name}` });
  }
  for (const [k, v] of Object.entries(task.environment)) env.push({ name: k, value: R(v) });

  let secret: CompiledTask['secret'];
  if (Object.keys(task.credentials).length) {
    const data: Record<string, string> = {};
    for (const [cred, mapping] of Object.entries(task.credentials)) {
      for (const envName of Object.keys(mapping)) {
        const val = ctx.credentialValues[cred]?.[envName];
        if (val === undefined) throw new Error(`credential ${cred}.${envName} was not resolved`);
        data[envName] = val;
        env.push({ name: envName, valueFrom: { secretKeyRef: { name: `${jobName}-creds`, key: envName } } });
      }
    }
    secret = { name: `${jobName}-creds`, data };
  }

  const volumes: unknown[] = [{ name: 'fsx', persistentVolumeClaim: { claimName: 'fsx-pvc' } }];
  const mounts: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[] = [{ name: 'fsx', mountPath: '/fsx' }];

  let configMap: CompiledTask['configMap'];
  if (task.files.length) {
    const data: Record<string, string> = {};
    const items: { key: string; path: string; mode?: number }[] = [];
    for (const f of task.files) {
      const key = cmToKey(f.path);
      data[key] = R(f.contents);
      items.push({ key, path: key, mode: f.mode ?? 0o755 });
    }
    configMap = { name: `${jobName}-files`, data };
    volumes.push({ name: 'files', configMap: { name: configMap.name, items, defaultMode: 0o755 } });
    // Each file is projected into /pai/files/<key>; an init step copies to the requested absolute path.
    mounts.push({ name: 'files', mountPath: '/pai/files', readOnly: true });
  }
  for (const i of task.inputs) {
    if ('dataset' in i) {
      const mountPath = i.dataset.path;
      const fsxPath = ctx.datasetPaths[i.dataset.name];
      if (mountPath && fsxPath && fsxPath.startsWith('/fsx/')) {
        mounts.push({ name: 'fsx', mountPath, subPath: fsxPath.slice('/fsx/'.length), readOnly: true });
      }
    }
  }
  if (res.shm_size) {
    volumes.push({ name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: res.shm_size } });
    mounts.push({ name: 'dshm', mountPath: '/dev/shm' });
  }
  for (const v of task.volumes) {
    // "hostPath:/container/path" — only /tmp/.X11-unix is allowed (DCV play jobs)
    const [host, cont] = v.split(':');
    if (host === '/tmp/.X11-unix' && cont) {
      volumes.push({ name: 'x11', hostPath: { path: '/tmp/.X11-unix', type: 'Directory' } });
      mounts.push({ name: 'x11', mountPath: cont });
    }
  }

  const requests: Record<string, string> = {};
  const limits: Record<string, string> = {};
  if (res.cpu !== undefined) requests.cpu = String(res.cpu);
  if (res.memory) requests.memory = res.memory;
  if (res.storage) requests['ephemeral-storage'] = res.storage;
  if (res.gpu) limits['nvidia.com/gpu'] = String(res.gpu);
  if (res.efa) limits['vpc.amazonaws.com/efa'] = '1';
  if (res.memory) limits.memory = res.memory;

  const nodeSelector: Record<string, string> = { 'sagemaker.amazonaws.com/node-health-status': 'Schedulable' };
  const platform = task.platform ?? res.platform;
  if (platform) nodeSelector['node.kubernetes.io/instance-type'] = platform;

  const tolerations: unknown[] = [];
  if (res.gpu) tolerations.push({ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' });

  const fileCopy = task.files.length
    ? task.files.map((f) => `mkdir -p "$(dirname '${f.path}')" && cp /pai/files/${cmToKey(f.path)} '${f.path}' && chmod ${(f.mode ?? 0o755).toString(8)} '${f.path}'`).join(' && ') + ' && '
    : '';
  const userCmd = [...(task.command ?? []), ...(task.args ?? [])].map(R);
  const shellQuoted = userCmd.map((s) => `'${s.replace(/'/g, `'\\''`)}'`).join(' ');
  const command = ['/bin/sh', '-c', `${fileCopy}mkdir -p '${output}' && exec ${shellQuoted}`];

  const activeDeadlineSeconds = durationToSeconds(task.timeout ?? wf.timeout.exec_timeout);

  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace: ctx.namespace, labels: { ...labels, ...kueueLabels }, annotations: { 'pai.aws/workflow-name': wf.name } },
    spec: {
      backoffLimit: task.retry.max_retries,
      activeDeadlineSeconds,
      ttlSecondsAfterFinished: 7 * 86400,
      ...(task.parallelism > 1 ? { completions: task.parallelism, parallelism: task.parallelism, completionMode: 'Indexed' } : {}),
      template: {
        metadata: { labels: { ...labels, ...kueueLabels } },
        spec: {
          restartPolicy: 'Never',
          ...(ctx.serviceAccountName ? { serviceAccountName: ctx.serviceAccountName } : {}),
          nodeSelector,
          tolerations,
          volumes,
          terminationGracePeriodSeconds: 60,
          containers: [
            {
              name: 'main',
              image: task.image,
              command,
              workingDir: task.working_dir,
              env,
              resources: { requests, limits },
              volumeMounts: mounts,
            },
          ],
        },
      },
    },
  };
  return { jobName, job, configMap, secret, outputPath: output };
}

export function sanitizeLabel(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').slice(0, 63) || 'unknown';
}

export function mlflowUriFromConfig(): string | undefined {
  return config().groot?.mlflowTrackingServerArn;
}
