import { assertPlan, placementAffinity, TOPOLOGY_ANNOTATION } from './topology/affinity';
import type { TopologyPlan } from './topology/types';
import { storageLayout, assertProjectInput, assertInputMount, workloadSecurity, type SharedReadOnlyPath } from './storage-layout';
import { createHash } from 'node:crypto';
import { assertEnvironment, assertInjectionPath, assertSafePath, shellQuote } from './validation';
import { config } from '../config';
import { managedLabels } from '../k8s/resources';
import { durationToSeconds, type ResourceSpec, type TaskSpec, type WorkflowSpec } from './schema';
import { checkpointPath, checkpointURL } from './checkpoints';
export const LABEL_WF = 'pai.aws/workflow-id';
export const LABEL_TASK = 'pai.aws/task';
export const LABEL_OWNER = 'pai.aws/owner';
export interface CompileContext {
  backendId?: string;
  workflowId: string;
  /** Trusted, durable admission-unit plan; never sourced from YAML. */
  topologyPlan?: TopologyPlan;
  projectId?: string;
  attempt?: number;
  artifactBucket?: string;
  checkpointRestore?: boolean;
  taskOutputPaths?: Record<string, string>;
  runtimeCommand?: string;
  runtimeImage?: string;
  runtimeEnvironment?: Record<string, string>;
  epoch?: string;
  sharedReadOnlyPaths?: SharedReadOnlyPath[];
  workloadServiceAccount?: string;
  group?: {
    name: string;
    epoch: string;
    members: string[];
    participants?: {
      id: string;
      task: string;
      replicaIndex: number;
      resource: string;
    }[];
    barrier: boolean;
    ignoreNonleadStatus: boolean;
    lead: string;
  };
  owner: string;
  namespace: string;
  queue?: string; // Kueue LocalQueue name or undefined
  priority?: string;
  /** Overall task input index → pinned FSx path. Authoritative when supplied. */
  datasetPathsByInput?: Record<number, string>;
  /** Legacy name lookup, supported only when a name does not refer to multiple versions. */
  datasetPaths: Record<string, string>;
  /** credential name → {ENV: value} resolved from SSM */
  credentialValues: Record<string, Record<string, string>>;
  mlflowTrackingUri?: string;
}
export interface CompiledTask {
  jobName: string;
  job: Record<string, unknown>;
  configMap?: {
    name: string;
    data: Record<string, string>;
  };
  secret?: {
    name: string;
    data: Record<string, string>;
  };
  outputPath: string;
}
export function outputPathFor(workflowId: string, task: string, attempt = 1, projectId?: string): string {
  const root = projectId ? `/fsx/checkpoints/projects/${projectId}/runs/${workflowId}/attempts/${attempt}/${task}` : `/fsx/checkpoints/workflows/${workflowId}/${task}${attempt > 1 ? `/attempts/${attempt}` : ''}`;
  assertSafePath(root);
  return root;
}
export function jobNameFor(workflowId: string, task: string, attempt = 1): string {
  const name = `wf-${workflowId}-${task}${attempt > 1 ? `-a${attempt}` : ''}`;
  return name.length <= 55 ? name : `${name.slice(0, 42).replace(/-+$/, '')}-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
}

/** Leave room for JobSet's -<replicatedJob>-<jobIndex>-<podIndex> suffix. */
export function jobSetNameFor(workflowId: string, group: string, attempt = 1): string {
  return `g${createHash('sha256').update(`${workflowId}:${group}:${attempt}`).digest('hex').slice(0, 16)}`;
}

/** Resolve the Kueue LocalQueue for a namespace, mirroring render.sh. */
export function queueForNamespace(ns: string, explicit?: string): string | undefined {
  if (explicit && explicit !== 'auto') return explicit === 'none' ? undefined : explicit;
  return ns.startsWith('hyperpod-ns-') ? `${ns}-localqueue` : undefined;
}
const cmToKey = (p: string) => p.replace(/^\//, '').replace(/[^A-Za-z0-9._-]/g, '_');
export function resolvePlaceholders(text: string, ctx: {
  output: string;
  inputs: string[];
  workflowId: string;
  taskName: string;
}): string {
  return text.replace(/\{\{\s*output\s*\}\}/g, ctx.output).replace(/\{\{\s*workflow_id\s*\}\}/g, ctx.workflowId).replace(/\{\{\s*task_name\s*\}\}/g, ctx.taskName).replace(/\{\{\s*input:(\d+)\s*\}\}/g, (_m, i: string) => ctx.inputs[Number(i)] ?? `/fsx/checkpoints/workflows/${ctx.workflowId}/__missing_input_${i}`);
}
/** Shared by the compiler and durable launch intent; do not infer application exits from wrapper exits. */
export function usesRuntime(task: TaskSpec, ctx: Pick<CompileContext, 'projectId' | 'runtimeImage'>, grouped = false): boolean {
  return grouped || !!task.checkpoint?.length || Boolean(ctx.projectId && ctx.runtimeImage);
}
export function compileTask(spec: WorkflowSpec, task: TaskSpec, ctx: CompileContext): CompiledTask {
  const wf = spec.workflow;
  if (ctx.projectId && task.volumes.length) throw new Error('user volumes are not permitted for project workloads');
  const res: ResourceSpec = wf.resources[task.resource] ?? {};
  if (res.topology?.length && !ctx.topologyPlan) throw new Error('Native OSMO topology requires a registered, durable placement plan');
  if (ctx.topologyPlan) {
    assertPlan(ctx.topologyPlan, ctx.workflowId, ctx.namespace, ctx.epoch ?? ctx.group?.epoch);
    if (!ctx.group && ctx.queue !== ctx.topologyPlan.queue) throw new Error('topology admission queue mismatch');
  }
  const affinity = placementAffinity(ctx.topologyPlan, task.name, res.nodesExcluded);
  const jobName = jobNameFor(ctx.workflowId, task.name, ctx.attempt);
  const output = outputPathFor(ctx.workflowId, task.name, ctx.attempt, ctx.projectId);
  const datasetSources = task.inputs.map((input, index) => {
    if (!('dataset' in input)) return undefined;
    if (ctx.datasetPathsByInput !== undefined) {
      const path = ctx.datasetPathsByInput[index];
      if (typeof path !== 'string' || !path) throw new Error(`dataset input ${index} has no indexed snapshot path`);
      return path;
    }
    if (task.inputs.some(other => 'dataset' in other && other.dataset.name === input.dataset.name && other.dataset.version !== input.dataset.version)) {
      throw new Error(`indexed dataset paths are required for multiple versions of ${input.dataset.name}`);
    }
    return ctx.datasetPaths[input.dataset.name];
  });
  const inputPaths = task.inputs.map((i, index) => 'task' in i ? ctx.taskOutputPaths?.[i.task] ?? outputPathFor(ctx.workflowId, i.task, 1, ctx.projectId) : i.dataset.path ?? datasetSources[index] ?? `/fsx/datasets/${i.dataset.name}`);
  const ph = {
    output,
    inputs: inputPaths,
    workflowId: ctx.workflowId,
    taskName: task.name
  };
  const R = (s: string) => resolvePlaceholders(s, ph).replace(
    /\{\{\s*host:([a-z0-9-]+)(?::(\d+))?\s*\}\}/g,
    (_match, member: string, replicaText?: string) => {
      const replica = Number(replicaText ?? '0');
      if (!ctx.group || !ctx.group.members.includes(`${member}:${replica}`)) throw new Error(`host:${member} must refer to a member of the same group`);
      const root = jobSetNameFor(ctx.workflowId, ctx.group.name, ctx.attempt);
      return `${root}-${member}-0-${replica}.${root}.${ctx.namespace}.svc.cluster.local`;
    },
  );
  const labels = managedLabels({
    ...(ctx.backendId ? { 'pai.aws/backend': ctx.backendId } : {}),
    ...(ctx.projectId ? { 'pai.aws/project': ctx.projectId } : {}),
    [LABEL_WF]: ctx.workflowId,
    [LABEL_TASK]: task.name,
    [LABEL_OWNER]: sanitizeLabel(ctx.owner),
    'pai.aws/attempt': String(ctx.attempt ?? 1),
    ...(ctx.epoch ? {
      'pai.aws/epoch': ctx.epoch
    } : {}),
    ...(ctx.group ? {
      'pai.aws/group': ctx.group.name,
      'pai.aws/epoch': ctx.group.epoch
    } : {})
  });
  const kueueLabels: Record<string, string> = {};
  if (ctx.queue) kueueLabels['kueue.x-k8s.io/queue-name'] = ctx.queue;
  if (ctx.queue && ctx.priority) kueueLabels['kueue.x-k8s.io/priority-class'] = ctx.priority;
  const env: {
    name: string;
    value?: string;
    valueFrom?: unknown;
  }[] = [{
    name: 'PAI_WORKFLOW_ID',
    value: ctx.workflowId
  }, {
    name: 'PAI_TASK_NAME',
    value: task.name
  }, {
    name: 'PAI_OUTPUT_DIR',
    value: output
  }, {
    name: 'PAI_ATTEMPT',
    value: String(ctx.attempt ?? 1)
  }, {
    name: 'PAI_ATTEMPT_EPOCH',
    value: ctx.epoch ?? ctx.group?.epoch ?? ''
  }, {
    name: 'PAI_TASK_REPLICAS',
    value: String(task.parallelism)
  }, {
    name: 'PAI_REPLICA_INDEX',
    ...(task.parallelism > 1 || ctx.group ? {
      valueFrom: {
        fieldRef: {
          fieldPath: "metadata.annotations['batch.kubernetes.io/job-completion-index']"
        }
      }
    } : {
      value: '0'
    })
  }, {
    name: 'OSMO_WORKFLOW_ID',
    value: ctx.workflowId
  }, {
    name: 'OSMO_TASK_NAME',
    value: task.name
  }, {
    name: 'OSMO_TASK_REPLICAS',
    value: String(task.parallelism)
  }, {
    name: 'OSMO_TASK_REPLICA_INDEX',
    valueFrom: {
      fieldRef: {
        fieldPath: "metadata.annotations['batch.kubernetes.io/job-completion-index']"
      }
    }
  }, {
    name: 'PYTHONUNBUFFERED',
    value: '1'
  }, {
    name: 'HOME',
    value: '/tmp/pai-home'
  }, {
    name: 'XDG_CACHE_HOME',
    value: '/tmp/pai-cache'
  }];
  if (ctx.mlflowTrackingUri) {
    env.push({
      name: 'MLFLOW_TRACKING_URI',
      value: ctx.mlflowTrackingUri
    }, {
      name: 'MLFLOW_EXPERIMENT_NAME',
      value: wf.name
    }, {
      name: 'MLFLOW_RUN_NAME',
      value: `${ctx.workflowId}/${task.name}`
    });
  }
  for (const [k, v] of Object.entries(task.environment)) {
    assertEnvironment(k);
    env.push({
      name: k,
      value: R(v)
    });
  }
  const controlSecrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(ctx.runtimeEnvironment ?? {})) {
    if (!/^PAI_RUNTIME_[A-Z0-9_]+$/.test(name)) throw new Error('trusted runtime environment may only supply PAI_RUNTIME_* variables');
    if (name.endsWith('_TOKEN')) {
      controlSecrets[name] = value;
      env.push({ name, valueFrom: { secretKeyRef: { name: `${jobName}-creds`, key: name } } });
    } else env.push({ name, value });
  }
  if (ctx.runtimeEnvironment?.PAI_RUNTIME_MLFLOW_URI) {
    const prior = env.findIndex((entry) => entry.name === 'MLFLOW_TRACKING_URI');
    if (prior >= 0) env.splice(prior, 1);
    env.push({ name: 'MLFLOW_TRACKING_URI', value: ctx.runtimeEnvironment.PAI_RUNTIME_MLFLOW_URI });
    env.push({ name: 'MLFLOW_TRACKING_TOKEN', valueFrom: { secretKeyRef: { name: `${jobName}-creds`, key: 'PAI_RUNTIME_MLFLOW_TOKEN' } } });
  }
  let secret: CompiledTask['secret'];
  if (Object.keys(task.credentials).length || Object.keys(controlSecrets).length) {
    const data: Record<string, string> = { ...controlSecrets };
    for (const [cred, mapping] of Object.entries(task.credentials)) {
      for (const envName of Object.keys(mapping)) {
        assertEnvironment(envName);
        const val = ctx.credentialValues[cred]?.[envName];
        if (val === undefined) throw new Error(`credential ${cred}.${envName} was not resolved`);
        data[envName] = val;
        env.push({
          name: envName,
          valueFrom: {
            secretKeyRef: {
              name: `${jobName}-creds`,
              key: envName
            }
          }
        });
      }
    }
    secret = {
      name: `${jobName}-creds`,
      data
    };
  }
  const {
    volumes,
    mounts,
    initContainers
  } = storageLayout(ctx.projectId, ctx.runtimeImage, ctx.sharedReadOnlyPaths);
  const needsRuntime = usesRuntime(task, ctx, !!ctx.group);
  const runtimeCommand = ctx.runtimeCommand ?? (ctx.runtimeImage ? '/opt/pai/runtime' : undefined);
  if (needsRuntime && ctx.runtimeImage) {
    volumes.push({
      name: 'pai-runtime',
      emptyDir: {}
    });
    mounts.push({
      name: 'pai-runtime',
      mountPath: '/opt/pai',
      readOnly: true
    });
    initContainers.push({
      name: 'pai-runtime-install',
      image: ctx.runtimeImage,
      command: ['/bin/cp', '/opt/pai/runtime', '/pai-runtime/runtime'],
      volumeMounts: [{
        name: 'pai-runtime',
        mountPath: '/pai-runtime'
      }],
      securityContext: {
        runAsUser: 0,
        runAsGroup: 0,
        runAsNonRoot: false,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: {
          drop: ['ALL']
        },
        seccompProfile: {
          type: 'RuntimeDefault'
        }
      }
    });
  }
  let configMap: CompiledTask['configMap'];
  if (task.files.length) {
    const data: Record<string, string> = {};
    const items: {
      key: string;
      path: string;
      mode?: number;
    }[] = [];
    for (const f of task.files) {
      assertInjectionPath(f.path);
      const key = cmToKey(f.path);
      data[key] = R(f.contents);
      items.push({
        key,
        path: key,
        mode: f.mode ?? 0o755
      });
    }
    configMap = {
      name: `${jobName}-files`,
      data
    };
    volumes.push({
      name: 'files',
      configMap: {
        name: configMap.name,
        items,
        defaultMode: 0o755
      }
    });
    // Each file is projected into /pai/files/<key>; an init step copies to the requested absolute path.
    mounts.push({
      name: 'files',
      mountPath: '/pai/files',
      readOnly: true
    });
  }
  for (const [index, i] of task.inputs.entries()) {
    const source = 'task' in i ? ctx.taskOutputPaths?.[i.task] ?? outputPathFor(ctx.workflowId, i.task, 1, ctx.projectId) : datasetSources[index];
    const target = 'dataset' in i ? i.dataset.path ?? (ctx.projectId ? source : undefined) : ctx.projectId ? source : undefined;
    if (ctx.projectId) {
      if (!source) throw new Error('project dataset snapshot has no resolved path');
      assertProjectInput(source, ctx.projectId);
    }
    if (source) assertSafePath(source);
    if (source && target && source.startsWith('/fsx/')) {
      assertInputMount(target, source, ctx.projectId);
      const targets = ctx.projectId && target !== source ? [target, source] : [target];
      for (const mountPath of targets) {
        const existing = mounts.find(m => m.mountPath === mountPath);
        if (existing) {
          if (existing.name !== 'fsx' || existing.subPath !== source.slice(5) || !existing.readOnly) {
            throw new Error(`input mount ${mountPath} conflicts with another input or reserved mount`);
          }
          continue;
        }
        mounts.push({
          name: 'fsx',
          mountPath,
          subPath: source.slice(5),
          readOnly: true
        });
      }
    }
  }
  if (res.shm_size) {
    volumes.push({
      name: 'dshm',
      emptyDir: {
        medium: 'Memory',
        sizeLimit: res.shm_size
      }
    });
    mounts.push({
      name: 'dshm',
      mountPath: '/dev/shm'
    });
  }
  for (const v of task.volumes) {
    // "hostPath:/container/path" — only /tmp/.X11-unix is allowed (DCV play jobs)
    const [host, cont] = v.split(':');
    if (host === '/tmp/.X11-unix' && cont) {
      volumes.push({
        name: 'x11',
        hostPath: {
          path: '/tmp/.X11-unix',
          type: 'Directory'
        }
      });
      mounts.push({
        name: 'x11',
        mountPath: cont
      });
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
  const nodeSelector: Record<string, string> = {
    'sagemaker.amazonaws.com/node-health-status': 'Schedulable',
    ...ctx.topologyPlan?.tasks[task.name]?.required
  };
  const platform = task.platform ?? res.platform;
  if (platform) nodeSelector['node.kubernetes.io/instance-type'] = platform;
  const tolerations: unknown[] = [];
  if (res.gpu) tolerations.push({
    key: 'nvidia.com/gpu',
    operator: 'Exists',
    effect: 'NoSchedule'
  });
  const fileCopy = task.files.length ? task.files.map(f => `p=${shellQuote(f.path)}; while [ \"$p\" != / ]; do [ ! -L \"$p\" ] || exit 125; p=\"$(dirname \"$p\")\"; done; mkdir -p ${shellQuote(f.path.slice(0, f.path.lastIndexOf('/')) || '/')} && cp /pai/files/${cmToKey(f.path)} ${shellQuote(f.path)} && chmod ${(f.mode ?? 0o755).toString(8)} ${shellQuote(f.path)}`).join(' && ') + ' && ' : '';
  const userCmd = [...(task.command ?? []), ...(task.args ?? [])].map(R);
  const shellQuoted = userCmd.map(s => `'${s.replace(/'/g, `'\\''`)}'`).join(' ');
  if (!userCmd.length) throw new Error(`task ${task.name}: explicit command required`);
  let run = shellQuoted;
  if (needsRuntime) {
    if (!runtimeCommand) throw new Error('verified workload runtime is required for groups/checkpoint');
    const runtime = {
      workflowId: ctx.workflowId,
      projectId: ctx.projectId,
      namespace: ctx.namespace,
      task: task.name,
      attempt: ctx.attempt ?? 1,
      epoch: ctx.epoch ?? ctx.group?.epoch,
      outputPath: output,
      replicaIndexEnv: 'PAI_REPLICA_INDEX',
      group: ctx.group,
      checkpoint: task.checkpoint?.map((checkpoint, index) => ({
        ...checkpoint, path: checkpointPath(checkpoint, { outputPath: output, workflowId: ctx.workflowId, task: task.name }),
        url: checkpointURL(checkpoint, index, { workflowId: ctx.workflowId, task: task.name, projectId: ctx.projectId, artifactBucket: ctx.artifactBucket }),
      })),
      ...(ctx.checkpointRestore ? { checkpointRestore: true } : {}),
      exitActions: task.exitActions
    };
    if (ctx.projectId && ctx.runtimeImage && task.inputs.some((input) => 'dataset' in input)) {
      initContainers.push({
        name: 'pai-input-hydration',
        image: ctx.runtimeImage,
        command: ['/opt/pai/runtime', '--prepare-inputs', '--contract', JSON.stringify(runtime)],
        env: env.filter((variable) => variable.name.startsWith('PAI_RUNTIME_') || variable.name === 'PAI_REPLICA_INDEX' || variable.name === 'OSMO_TASK_REPLICA_INDEX'),
        volumeMounts: [{
          name: 'fsx',
          mountPath: `/fsx/datasets/projects/${ctx.projectId}`,
          subPath: `datasets/projects/${ctx.projectId}`,
        }],
        securityContext: {
          runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true,
          allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' },
        },
      });
    }
    run = `${shellQuote(runtimeCommand)} --contract ${shellQuote(JSON.stringify(runtime))} -- ${shellQuoted}`;
  }
  const command = ['/bin/sh', '-c', `set -eu; ${fileCopy}mkdir -p "$HOME" "$XDG_CACHE_HOME" ${shellQuote(output)} && exec ${run}`];
  const activeDeadlineSeconds = durationToSeconds(task.timeout ?? wf.timeout.exec_timeout);
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: ctx.namespace,
      labels: {
        ...labels,
        ...kueueLabels
      },
      annotations: {
        'pai.aws/workflow-name': wf.name,
        ...(ctx.topologyPlan ? { [TOPOLOGY_ANNOTATION]: ctx.topologyPlan.hash } : {}),
        ...(needsRuntime ? { 'pai.aws/runtime-wrapper': 'true' } : {})
      }
    },
    spec: {
      backoffLimit: 0,
      // Kubernetes deadline is a fallback; controller separates admission/start/exec clocks.
      activeDeadlineSeconds: activeDeadlineSeconds + durationToSeconds(wf.timeout.start_timeout ?? '10m'),
      ...(ctx.queue ? {
        suspend: true
      } : {}),
      ttlSecondsAfterFinished: 7 * 86400,
      ...(task.parallelism > 1 || ctx.group ? {
        completions: task.parallelism,
        parallelism: task.parallelism,
        completionMode: 'Indexed'
      } : {}),
      template: {
        metadata: {
          ...(ctx.topologyPlan ? { annotations: { [TOPOLOGY_ANNOTATION]: ctx.topologyPlan.hash } } : {}),
          labels: {
            ...labels,
            ...kueueLabels
          }
        },
        spec: {
          restartPolicy: 'Never',
          ...(initContainers.length ? {
            initContainers
          } : {}),
          ...(ctx.projectId ? {
            automountServiceAccountToken: false,
            serviceAccountName: ctx.workloadServiceAccount ?? 'pai-workload',
            securityContext: {
              runAsUser: 1000,
              runAsGroup: 1000,
              runAsNonRoot: true,
              seccompProfile: {
                type: 'RuntimeDefault'
              }
            }
          } : {}),
          nodeSelector,
          ...(affinity ? { affinity } : {}),
          tolerations,
          volumes,
          terminationGracePeriodSeconds: 60,
          containers: [{
            name: 'main',
            ...(ctx.projectId ? {
              securityContext: workloadSecurity
            } : {}),
            image: task.image,
            command,
            workingDir: task.working_dir,
              env,
              ports: [
                ...(task.ports ?? []).filter((port) => port.name !== 'pai-files' && port.containerPort !== 8077),
                ...(needsRuntime ? [{ name: 'pai-files', containerPort: 8077, protocol: 'TCP' }] : []),
              ],
            resources: {
              requests,
              limits
            },
            volumeMounts: mounts
          }]
        }
      }
    }
  };
  return {
    jobName,
    job,
    configMap,
    secret,
    outputPath: output
  };
}
export function sanitizeLabel(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').slice(0, 63) || 'unknown';
}
export function mlflowUriFromConfig(): string | undefined {
  return config().groot?.mlflowTrackingServerArn;
}
