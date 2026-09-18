import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo } from '../aws/clients';
import { config } from '../config';
import type { Item } from '../store/dynamo';
import type { Node, Pod } from '../k8s/resources';
import type { ClusterInstanceGroupDetails, ClusterNodeSummary } from '@aws-sdk/client-sagemaker';
import { TERMINAL_TASK, TERMINAL_WF } from '../store/types';
import { createHash } from 'node:crypto';
import { SYSTEM_NAMESPACES } from '../k8s/client';

export type ScaleNode = Node & { metadata: Node['metadata'] & { resourceVersion?: string }; spec?: Node['spec'] & { providerID?: string } };
export type ScalePod = Pod & { metadata: Pod['metadata'] & { ownerReferences?: Array<{ kind?: string; name?: string }> } };
export interface Blocker { code: string; message: string; resources?: string[] }
export interface ActivityRows { items: Item[]; complete: boolean; observedAt: string }
export interface NodeTarget { instanceId: string; name: string; uid: string; resourceVersion: string }
export const SCALE_ANNOTATION = 'pai.aws/scale-operation';
/** Home-table consistent reads, all relevant pages; never expose raw records in the API. */
export async function scanScalingActivity(): Promise<ActivityRows> {
  const observedAt = new Date().toISOString();
  const client = DynamoDBDocumentClient.from(dynamo(), { marshallOptions: { removeUndefinedValues: true } });
  const fields = ['pk', 'sk', 'id', 'name', 'status', 'phase', 'workflowId', 'projectId', 'backendId', 'namespace', 'nodeName', 'kind', 'ssmTarget',
    'closedAt', 'revokedAt', 'expiresAt', 'updatedAt', 'createdAt', 'provisioningUntil', 'state', 'revision', 'attempts'];
  const names = Object.fromEntries(fields.map((field, i) => [`#f${i}`, field]));
  const items: Item[] = [], seen = new Set<string>(); let key: Record<string, unknown> | undefined;
  do {
    const response = await client.send(new ScanCommand({ TableName: config().tableName, ConsistentRead: true, Limit: 1000,
      ProjectionExpression: Object.keys(names).join(','), ExpressionAttributeNames: names,
      FilterExpression: 'begins_with(#f0,:wf) OR begins_with(#f0,:session) OR begins_with(#f0,:dataset) OR begins_with(#f0,:project)',
      ExpressionAttributeValues: { ':wf': 'WF#', ':session': 'SESS#', ':dataset': 'DS#', ':project': 'PROJECT#' }, ExclusiveStartKey: key,
    }), { abortSignal: AbortSignal.timeout(15_000) });
    items.push(...(response.Items ?? []) as Item[]); key = response.LastEvaluatedKey;
    if (key) {
      const encoded = JSON.stringify(key);
      if (seen.has(encoded) || seen.size >= 100 || items.length > 100_000) return { items, complete: false, observedAt };
      seen.add(encoded);
    }
  } while (key);
  return { items, complete: true, observedAt };
}
/** Accept complete AWS identities only; a provider ID is stronger evidence than a reusable node name. */
function providerMatchesInstance(provider: string, instanceId: string, clusterArn?: string): boolean {
  const match = /^aws:\/\/\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:sagemaker\/cluster\/hyperpod-([a-z0-9]{12})-)?(i-[a-f0-9]{8}(?:[a-f0-9]{9})?)$/.exec(provider);
  // JS $ also matches before a final newline, which is not part of a valid identity.
  if (!match || match[0] !== provider || match[2] !== instanceId) return false;
  if (match[1] && clusterArn !== undefined) {
    const cluster = /^arn:aws[a-z-]*:sagemaker:[a-z0-9-]+:[0-9]{12}:cluster\/([a-z0-9]{12})$/.exec(clusterArn);
    if (!cluster || cluster[0] !== clusterArn || cluster[1] !== match[1]) return false;
  }
  return true;
}
export function inspectActivity(backendId: string, group: ClusterInstanceGroupDetails, nodes: ScaleNode[], pods: ScalePod[], instances: ClusterNodeSummary[], rows: ActivityRows, now: Date, operationId?: string, clusterArn?: string) {
  const blockers: Blocker[] = [], targets: NodeTarget[] = [];
  const add = (code: string, message: string, resources?: string[]) => blockers.push({ code, message, ...(resources?.length ? { resources: resources.slice(0, 20) } : {}) });
  if (!rows.complete || !Number.isFinite(Date.parse(rows.observedAt)) || Math.abs(now.getTime() - Date.parse(rows.observedAt)) > 60_000) add('activity_unknown', '작업·세션 기록을 빠짐없이 최근 시각으로 읽지 못했습니다.');
  const members = instances.filter(instance => instance.InstanceGroupName === group.InstanceGroupName);
  if (members.length !== group.CurrentCount || members.some(i => !/^i-[a-f0-9]{8}(?:[a-f0-9]{9})?$/.test(i.InstanceId ?? '') || i.InstanceType !== group.InstanceType || i.InstanceStatus?.Status !== 'Running')) add('inventory_unknown', '전체 인스턴스 수·유형·식별자 또는 건강한 실행 상태를 확인하지 못했습니다.');
  for (const instance of members) {
    const matching = nodes.filter(node => {
      if (!instance.InstanceId) return false;
      const provider = node.spec?.providerID;
      // A DNS name/IP can be reused after recovery. Never override a conflicting
      // provider identity with a weaker name match.
      return provider === undefined ? node.metadata.name === `hyperpod-${instance.InstanceId}` :
        typeof provider === 'string' && providerMatchesInstance(provider, instance.InstanceId, clusterArn);
    });
    const node = matching[0];
    if (matching.length !== 1 || !node?.metadata.uid || !node.metadata.resourceVersion ||
      nodes.filter(other => other.metadata.name === node.metadata.name || other.metadata.uid === node.metadata.uid).length !== 1 ||
      node.metadata.deletionTimestamp || !node.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True')) {
      add('node_mapping_unknown', '인스턴스와 Ready Kubernetes 노드의 UID·버전을 확인하지 못했습니다.', [instance.InstanceId ?? 'unknown']); continue;
    }
    if (node.spec?.unschedulable && node.metadata.annotations?.[SCALE_ANNOTATION] !== operationId) add('node_already_cordoned', '다른 운영 작업이 노드를 사용 중지했습니다.', [node.metadata.name]);
    if (node.metadata.labels?.['pai.aws.node-restriction.kubernetes.io/execution-profile'] || node.spec?.taints?.some(taint => taint.key === 'pai.aws/execution-profile')) {
      add('host_execution_unobserved', '호스트 권한 실행 전용 노드는 일반 Pod 조회만으로 유휴를 증명할 수 없어 이 축소 경로에서 제외합니다.', [node.metadata.name]);
    }
    targets.push({ instanceId: instance.InstanceId!, name: node.metadata.name, uid: node.metadata.uid, resourceVersion: node.metadata.resourceVersion });
  }
  if (new Set(targets.map(t => t.uid)).size !== targets.length) add('node_mapping_unknown', '여러 인스턴스가 같은 노드에 연결되어 있습니다.');
  const nodeNames = new Set(targets.map(t => t.name));
  const activePods = pods.filter(pod => !['Succeeded', 'Failed'].includes(pod.status?.phase ?? '') &&
    (nodeNames.has(pod.spec.nodeName ?? '') || !pod.spec.nodeName) &&
    // Only daemonset-managed platform agents are exempt, never an entire namespace.
    !(SYSTEM_NAMESPACES.has(pod.metadata.namespace ?? '') && pod.metadata.ownerReferences?.some(owner => owner.kind === 'DaemonSet')));
  if (activePods.length) add('pods_active', '실행·대기·종료 중인 Pod가 있습니다. 사용자 Pod를 축출하지 않습니다.', activePods.map(p => `${p.metadata.namespace}/${p.metadata.name}`));
  const projects = new Map(rows.items.filter(r => r.pk.startsWith('PROJECT#') && r.sk === 'META').map(r => [r.pk.slice(8), String(r.backendId ?? 'default')]));
  const workflows = rows.items.filter(r => r.pk.startsWith('WF#') && r.sk === 'META');
  const allWorkflowIds = new Set(workflows.map(r => r.pk.slice(3)));
  const orphanTasks = rows.items.filter(r => r.pk.startsWith('WF#') && r.sk.startsWith('TASK#') && !TERMINAL_TASK.has(r.phase as never) && !allWorkflowIds.has(r.pk.slice(3)));
  const unbound = rows.items.filter(r => (r.pk.startsWith('WF#') || r.pk.startsWith('SESS#')) && r.sk === 'META' && r.projectId && !r.backendId && !projects.has(String(r.projectId)));
  if (orphanTasks.length || unbound.length) add('ownership_unknown', '활성 기록의 워크플로·프로젝트 backend 소유 관계를 확인하지 못했습니다.');
  const belongs = (r: Item) => String(r.backendId ?? (r.projectId ? projects.get(String(r.projectId)) : undefined) ?? 'default') === backendId;
  const same = workflows.filter(belongs), wfIds = new Set(same.map(r => r.pk.slice(3)));
  const active = same.filter(r => !TERMINAL_WF.has(r.status as never));
  if (active.length) add('workflows_active', '이 backend에 대기·실행·취소·결과 확정 중인 워크플로가 있습니다.', active.map(r => String(r.id ?? r.pk.slice(3))));
  const tasks = rows.items.filter(r => r.pk.startsWith('WF#') && r.sk.startsWith('TASK#') && wfIds.has(r.pk.slice(3)));
  const unfinished = tasks.filter(r => !TERMINAL_TASK.has(r.phase as never));
  if (unfinished.length) add('tasks_unfinished', '작업 또는 결과 수집이 아직 끝나지 않았습니다.', unfinished.map(r => `${r.pk.slice(3)}/${r.name ?? r.sk.slice(5)}`));
  const allSessions = rows.items.filter(r => r.pk.startsWith('SESS#') && r.sk === 'META' && belongs(r));
  const sessions = allSessions.filter(r =>
    !(r.kind === 'dcv' && r.ssmTarget && !members.some(i => i.InstanceId && String(r.ssmTarget).includes(i.InstanceId))) &&
    (r.status !== 'CLOSED' || typeof r.provisioningUntil === 'string' && Date.parse(r.provisioningUntil) > now.getTime()));
  if (sessions.length) add('sessions_active', '실행·준비·종료 중이거나 상태가 불명확한 세션이 있습니다. TTL 만료만으로 유휴로 간주하지 않습니다.', sessions.map(r => String(r.id ?? r.pk)));
  const finalizations = rows.items.filter(r => r.pk.startsWith('DS#') && r.sk.startsWith('FINALIZE#')).filter(r => {
    const version = rows.items.find(v => v.pk === r.pk && v.sk.startsWith('V#') && Number(v.sk.slice(2)) === Number(r.sk.slice(9)));
    return !version || belongs(version);
  });
  if (finalizations.length) add('dataset_finalization', '데이터셋 버전 확정이 진행 중이거나 소유 backend를 확인하지 못했습니다.', finalizations.map(r => r.pk.slice(3)));
  const history = [...same, ...tasks, ...allSessions].map(r => [r.pk, r.sk, r.status, r.phase, r.updatedAt, r.createdAt, r.revision, r.attempts]);
  const historyHash = createHash('sha256').update(JSON.stringify(history.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex');
  return { blockers, targets: targets.sort((a, b) => a.instanceId.localeCompare(b.instanceId)), historyHash, observedAt: rows.observedAt };
}
