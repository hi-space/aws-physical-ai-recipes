import { randomBytes } from 'node:crypto';
import { config } from '../config';
import { badRequest, notFound } from '../errors';
import * as hp from '../aws/hyperpod';
import { applyDeployment, applyService, deleteByLabel, ensureFsxPvc, ensureNamespace, getDeployment, listPods, managedLabels } from '../k8s/resources';
import { getRepo } from '../store/repo';
import type { Session } from '../store/types';

const LABEL = 'pai.aws/session';

export async function createTensorBoard(input: { logDir: string; namespace?: string }, owner: string): Promise<Session> {
  const ns = input.namespace ?? config().defaultNamespace;
  if (!input.logDir.startsWith('/fsx/')) throw badRequest('logDir must be under /fsx');
  await ensureNamespace(ns);
  await ensureFsxPvc(ns);
  const id = randomBytes(3).toString('hex');
  const name = `tb-${id}`;
  const prefix = `/api/sessions/${id}/proxy`;
  const labels = managedLabels({ [LABEL]: id, app: name });
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: ns, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          nodeSelector: { 'node.kubernetes.io/instance-type': 'ml.c5.4xlarge' },
          volumes: [{ name: 'fsx', persistentVolumeClaim: { claimName: 'fsx-pvc' } }],
          containers: [
            {
              name: 'tensorboard',
              image: 'public.ecr.aws/docker/library/python:3.11',
              command: ['bash', '-ceu', `pip install -q tensorboard 2>&1 | tail -1; exec tensorboard --logdir '${input.logDir.replace(/'/g, '')}' --port 6006 --bind_all --path_prefix ${prefix} --reload_interval 15`],
              ports: [{ containerPort: 6006 }],
              resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '2Gi' } },
              volumeMounts: [{ name: 'fsx', mountPath: '/fsx', readOnly: true }],
              readinessProbe: { httpGet: { path: `${prefix}/`, port: 6006 }, initialDelaySeconds: 10, periodSeconds: 5 },
            },
          ],
        },
      },
    },
  };
  const service = { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels }, spec: { selector: { app: name }, ports: [{ port: 6006, targetPort: 6006 }] } };
  await applyDeployment(ns, deployment, name);
  await applyService(ns, service, name);
  const s: Session = { id, kind: 'tensorboard', namespace: ns, owner, logDir: input.logDir, name, createdAt: new Date().toISOString() };
  await getRepo().putSession(s);
  return s;
}

export async function listSessionsWithStatus() {
  const sessions = await getRepo().listSessions();
  return Promise.all(
    sessions.map(async (s) => {
      let status = 'unknown';
      try {
        const d = await getDeployment(s.namespace, s.name);
        if (!d) status = 'missing';
        else if ((d.status?.readyReplicas ?? 0) > 0) status = 'ready';
        else {
          const pods = await listPods(s.namespace, `app=${s.name}`);
          status = pods[0]?.status?.phase?.toLowerCase() ?? 'starting';
        }
      } catch (e) {
        status = `error: ${(e as Error).message}`;
      }
      return { ...s, status, url: `/api/sessions/${s.id}/proxy/` };
    }),
  );
}

export async function deleteSession(id: string) {
  const s = await getRepo().getSession(id);
  if (!s) throw notFound(`session ${id}`);
  await deleteByLabel(s.namespace, 'deployments', `${LABEL}=${id}`).catch(() => undefined);
  await deleteByLabel(s.namespace, 'services', `${LABEL}=${id}`).catch(() => undefined);
  await getRepo().deleteSession(id);
}

/** DCV targets on HyperPod nodes: SSM target strings + ready-to-run port-forward commands (mirrors scripts/eks/dcv-target.sh). */
export async function hyperPodDcvTargets() {
  const c = config();
  const out: { cluster: string; orchestrator: string; group: string; instanceId: string; instanceType: string; status: string; target: string; portForward: string; login: string }[] = [];
  const clusters = [c.eks?.hyperPodClusterName, c.slurm?.hyperPodClusterName].filter(Boolean) as string[];
  for (const name of clusters) {
    try {
      const d = await hp.describeCluster(name);
      const clusterId = d.ClusterArn?.split('/').pop() ?? '';
      const nodes = await hp.listNodes(name);
      const isEks = Boolean(d.Orchestrator?.Eks);
      for (const n of nodes) {
        const isGpu = /^ml\.(g|p)/.test(n.InstanceType ?? '');
        const isHead = n.InstanceGroupName === 'head';
        if (isHead || (!isGpu && isEks)) continue; // DCV runs on GPU nodes (EKS) or GPU/CPU compute nodes (Slurm)
        const target = `sagemaker-cluster:${clusterId}_${n.InstanceGroupName}-${n.InstanceId}`;
        out.push({
          cluster: name,
          orchestrator: isEks ? 'eks' : 'slurm',
          group: n.InstanceGroupName ?? '',
          instanceId: n.InstanceId ?? '',
          instanceType: n.InstanceType ?? '',
          status: n.InstanceStatus?.Status ?? '',
          target,
          portForward: `aws ssm start-session --region ${c.region} --target ${target} --document-name AWS-StartPortForwardingSession --parameters portNumber=8443,localPortNumber=8444`,
          login: isEks ? 'ec2-user / hyperpod' : 'ubuntu / hyperpod',
        });
      }
    } catch {
      /* cluster missing */
    }
  }
  return out;
}
