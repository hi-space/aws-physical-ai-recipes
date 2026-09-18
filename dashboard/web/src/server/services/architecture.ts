import { DescribeClusterCommand } from '@aws-sdk/client-eks';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { DescribeMlflowTrackingServerCommand, DescribePipelineCommand } from '@aws-sdk/client-sagemaker';
import { config } from '../config';
import { eks, s3, sagemaker } from '../aws/clients';
import { describeCluster } from '../aws/hyperpod';
import { describeAll as describeFileSystems } from '../aws/fsx';
import { describeWorkstation } from '../aws/ec2-dcv';
import { edgeCloud } from '../aws/greengrass';
import { listClusterQueues } from '../k8s/kueue';
import type { ConsoleResource } from '@/lib/console-links';

/**
 * The Physical-AI-on-AWS architecture as deployed, with live status per resource.
 *
 * Every component is either `evidence: 'describe'` (status/facts copied from the named API response) or
 * `evidence: 'config'` (only the identifier is known, from the deployment contract; the dashboard has no permitted
 * describe call for it). The UI never turns a config-only component into a green light.
 */
export type LayerId = 'data' | 'compute' | 'training' | 'simulation' | 'edge' | 'platform';
export type Tone = 'ok' | 'warn' | 'err' | 'unknown';
export type FactKey = 'instanceGroups' | 'nodeRecovery' | 'eksVersion' | 'capacityGiB' | 'dataRepositories' | 'clusterQueues' | 'instanceType' | 'members' | 'lastModified' | 'orchestrator';

export interface ArchComponent {
  id: string;
  layer: LayerId;
  /** AWS service name as AWS writes it. */
  service: string;
  /** Resource identifier (name, id or ARN) from config or the API response. */
  resource: string;
  evidence: 'describe' | 'config';
  /** API that produced `status`/`facts`, e.g. "SageMaker DescribeCluster". */
  api?: string;
  /** Raw status string from the API response. */
  status?: string;
  tone: Tone;
  /** Values copied from the API response; labels are translated in the UI. */
  facts?: { key: FactKey; value: string | number }[];
  /** Error message when the describe call failed (tone is then 'unknown'). */
  error?: string;
  console?: ConsoleResource;
  /** Dashboard route that works with this resource. */
  href?: string;
}

export interface ArchitectureResponse {
  fetchedAt: string;
  region: string;
  accountId: string;
  components: ArchComponent[];
}

export const LAYERS: LayerId[] = ['data', 'compute', 'training', 'simulation', 'edge', 'platform'];

// Tone by the API's own status vocabulary. Anything not listed is 'unknown' — never guessed.
const HYPERPOD: Record<string, Tone> = { InService: 'ok', Creating: 'warn', Updating: 'warn', SystemUpdating: 'warn', RollingBack: 'warn', Deleting: 'err', Failed: 'err' };
const EKS: Record<string, Tone> = { ACTIVE: 'ok', CREATING: 'warn', UPDATING: 'warn', PENDING: 'warn', DELETING: 'err', FAILED: 'err' };
const FSX: Record<string, Tone> = { AVAILABLE: 'ok', CREATING: 'warn', UPDATING: 'warn', DELETING: 'err', FAILED: 'err', MISCONFIGURED: 'err', MISCONFIGURED_UNAVAILABLE: 'err' };
const MLFLOW: Record<string, Tone> = { Created: 'ok', Started: 'ok', Updated: 'ok', Creating: 'warn', Updating: 'warn', Starting: 'warn', Stopping: 'warn', Stopped: 'warn', MaintenanceInProgress: 'warn', MaintenanceComplete: 'ok', Deleting: 'err', CreateFailed: 'err', UpdateFailed: 'err', DeleteFailed: 'err', StartFailed: 'err', StopFailed: 'err', MaintenanceFailed: 'err' };
const PIPELINE: Record<string, Tone> = { Active: 'ok', Deleting: 'err' };
const EC2: Record<string, Tone> = { running: 'ok', pending: 'warn', stopping: 'warn', 'shutting-down': 'warn', stopped: 'warn', terminated: 'err' };
const toneOf = (table: Record<string, Tone>, status?: string): Tone => (status && table[status]) || 'unknown';

async function describe<T>(base: Omit<ArchComponent, 'tone' | 'evidence'>, call: () => Promise<T>, map: (value: T) => { status?: string; tone: Tone; facts?: ArchComponent['facts']; resource?: string }): Promise<ArchComponent> {
  try {
    const mapped = map(await call());
    return { ...base, ...mapped, resource: mapped.resource ?? base.resource, evidence: 'describe' };
  } catch (e) {
    return { ...base, evidence: 'describe', tone: 'unknown', error: e instanceof Error ? e.message : String(e) };
  }
}
const configured = (base: Omit<ArchComponent, 'tone' | 'evidence' | 'api'>): ArchComponent => ({ ...base, evidence: 'config', tone: 'unknown' });

async function collect(): Promise<ArchComponent[]> {
  const c = config();
  const jobs: Promise<ArchComponent>[] = [];

  // ---- data
  const bucket = (id: string, name: string, href: string, prefix?: string) =>
    describe({ id, layer: 'data', service: 'Amazon S3', resource: name, api: 'S3 HeadBucket', console: { kind: 's3-bucket', bucket: name, prefix }, href },
      () => s3().send(new HeadBucketCommand({ Bucket: name })), () => ({ tone: 'ok' }));
  if (c.eks?.dataBucket) jobs.push(bucket('data-bucket', c.eks.dataBucket, '/storage', 'datasets/'));
  if (c.groot?.artifactsBucket && c.groot.artifactsBucket !== c.eks?.dataBucket) jobs.push(bucket('artifacts-bucket', c.groot.artifactsBucket, '/models'));
  if (c.slurm?.dataBucket && c.slurm.dataBucket !== c.eks?.dataBucket) jobs.push(bucket('slurm-data-bucket', c.slurm.dataBucket, '/storage'));
  if (c.eks?.fsxFileSystemId) {
    const id = c.eks.fsxFileSystemId;
    jobs.push(describe({ id: 'fsx', layer: 'data', service: 'Amazon FSx for Lustre', resource: id, api: 'FSx DescribeFileSystems · DescribeDataRepositoryAssociations', console: { kind: 'fsx-filesystem', id }, href: '/compute' },
      describeFileSystems, (all) => {
        const fs = all.find((f) => f.id === id);
        if (!fs) throw new Error(`file system ${id} not in DescribeFileSystems response`);
        const facts: ArchComponent['facts'] = [];
        if (fs.storageCapacityGiB !== undefined) facts.push({ key: 'capacityGiB', value: fs.storageCapacityGiB });
        facts.push({ key: 'dataRepositories', value: fs.associations.length });
        return { status: fs.lifecycle, tone: toneOf(FSX, fs.lifecycle), facts };
      }));
  }

  // ---- compute
  const hyperpod = (id: string, name: string, orchestrator: 'eks' | 'slurm') =>
    describe({ id, layer: 'compute', service: 'Amazon SageMaker HyperPod', resource: name, api: 'SageMaker DescribeCluster', console: { kind: 'hyperpod-cluster', name }, href: '/compute' },
      () => describeCluster(name), (d) => ({
        status: d.ClusterStatus, tone: toneOf(HYPERPOD, d.ClusterStatus),
        facts: [{ key: 'orchestrator', value: orchestrator === 'eks' ? 'EKS' : 'Slurm' }, { key: 'instanceGroups', value: d.InstanceGroups?.length ?? 0 }, ...(d.NodeRecovery ? [{ key: 'nodeRecovery' as FactKey, value: d.NodeRecovery }] : [])],
      }));
  if (c.eks) {
    const e = c.eks;
    jobs.push(hyperpod('hyperpod-eks', e.hyperPodClusterName, 'eks'));
    jobs.push(describe({ id: 'eks', layer: 'compute', service: 'Amazon EKS', resource: e.eksClusterName, api: 'EKS DescribeCluster', console: { kind: 'eks-cluster', name: e.eksClusterName }, href: '/compute' },
      () => eks().send(new DescribeClusterCommand({ name: e.eksClusterName })), (out) => ({
        status: out.cluster?.status, tone: toneOf(EKS, out.cluster?.status), facts: out.cluster?.version ? [{ key: 'eksVersion', value: out.cluster.version }] : [],
      })));
    jobs.push(describe({ id: 'kueue', layer: 'compute', service: 'Kueue (Kubernetes)', resource: e.eksClusterName, api: 'Kubernetes API kueue.x-k8s.io/v1beta1 ClusterQueue', href: '/queues' },
      listClusterQueues, (queues) => ({ tone: 'ok', facts: [{ key: 'clusterQueues', value: queues.length }] })));
    if (e.ampWorkspaceId) jobs.push(Promise.resolve(configured({ id: 'amp', layer: 'compute', service: 'Amazon Managed Service for Prometheus', resource: e.ampWorkspaceId, console: { kind: 'amp-workspace', id: e.ampWorkspaceId }, href: '/metrics' })));
  }
  if (c.slurm) jobs.push(hyperpod('hyperpod-slurm', c.slurm.hyperPodClusterName, 'slurm'));

  // ---- training / models
  if (c.groot?.pipelineName) {
    const name = c.groot.pipelineName;
    jobs.push(describe({ id: 'pipeline', layer: 'training', service: 'Amazon SageMaker Pipelines', resource: name, api: 'SageMaker DescribePipeline', href: '/pipelines' },
      () => sagemaker().send(new DescribePipelineCommand({ PipelineName: name })), (d) => ({
        status: d.PipelineStatus, tone: toneOf(PIPELINE, d.PipelineStatus), facts: d.LastModifiedTime ? [{ key: 'lastModified', value: d.LastModifiedTime.toISOString() }] : [],
      })));
  }
  if (c.groot?.mlflowTrackingServerArn) {
    const name = c.groot.mlflowTrackingServerName ?? c.groot.mlflowTrackingServerArn.split('/').pop() ?? c.groot.mlflowTrackingServerArn;
    jobs.push(describe({ id: 'mlflow', layer: 'training', service: 'Amazon SageMaker AI · MLflow tracking server', resource: name, api: 'SageMaker DescribeMlflowTrackingServer', href: '/experiments' },
      () => sagemaker().send(new DescribeMlflowTrackingServerCommand({ TrackingServerName: name })), (d) => ({ status: d.TrackingServerStatus, tone: toneOf(MLFLOW, d.TrackingServerStatus) })));
  }
  if (c.groot?.modelPackageGroup) jobs.push(Promise.resolve(configured({ id: 'model-registry', layer: 'training', service: 'Amazon SageMaker Model Registry', resource: c.groot.modelPackageGroup, href: '/models' })));

  // ---- simulation
  if (c.dcv) {
    const id = c.dcv.instanceId;
    jobs.push(describe({ id: 'dcv', layer: 'simulation', service: 'Amazon EC2 · NICE DCV', resource: id, api: 'EC2 DescribeInstances', console: { kind: 'ec2-instance', id }, href: '/sessions' },
      describeWorkstation, (w) => ({ status: w.state, tone: toneOf(EC2, w.state), facts: w.instanceType ? [{ key: 'instanceType', value: w.instanceType }] : [] })));
  }

  // ---- edge
  if (c.edge?.thingGroup) {
    const name = c.edge.thingGroup;
    jobs.push(describe({ id: 'thing-group', layer: 'edge', service: 'AWS IoT Greengrass', resource: name, api: 'IoT DescribeThingGroup · ListThingsInThingGroup', console: { kind: 'iot-thing-group', name }, href: '/edge' },
      () => edgeCloud().target('thing-group', name), (g) => ({ tone: 'ok', facts: [{ key: 'members', value: g.members?.length ?? 0 }] })));
  }
  if (c.edge?.inferenceComponent) jobs.push(Promise.resolve(configured({ id: 'gg-component', layer: 'edge', service: 'AWS IoT Greengrass component', resource: c.edge.inferenceComponent, href: '/edge' })));

  // ---- platform (identifiers only: the dashboard has no describe permission for its own plumbing)
  if (c.cognitoUserPoolId) jobs.push(Promise.resolve(configured({ id: 'cognito', layer: 'platform', service: 'Amazon Cognito', resource: c.cognitoUserPoolId, console: { kind: 'cognito-user-pool', id: c.cognitoUserPoolId }, href: '/access' })));
  jobs.push(Promise.resolve(configured({ id: 'table', layer: 'platform', service: 'Amazon DynamoDB', resource: c.tableName, console: { kind: 'dynamodb-table', name: c.tableName }, href: '/admin' })));
  if (c.eks) jobs.push(Promise.resolve(configured({ id: 'cluster-logs', layer: 'platform', service: 'Amazon CloudWatch Logs', resource: c.eks.logGroupPrefix, console: { kind: 'log-group', name: c.eks.logGroupPrefix }, href: '/compute' })));

  return Promise.all(jobs);
}

let cache: { at: number; value: ArchitectureResponse } | undefined;
const TTL_MS = 60_000;

export async function architectureMap(now = Date.now()): Promise<ArchitectureResponse> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const c = config();
  const value: ArchitectureResponse = { fetchedAt: new Date(now).toISOString(), region: c.region, accountId: c.accountId, components: await collect() };
  cache = { at: now, value };
  return value;
}
export function resetArchitectureCacheForTests(): void { cache = undefined; }
