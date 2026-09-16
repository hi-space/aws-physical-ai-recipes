import type { ClusterInstanceGroupDetails } from '@aws-sdk/client-sagemaker';
import { backendConfig as config } from '../backends/context';
import { HttpError, badRequest } from '../errors';
import * as hp from '../aws/hyperpod';
import { listNodes, listPods, type Node, type Pod } from '../k8s/resources';
import { SYSTEM_NAMESPACES } from '../k8s/client';
import { getRepo } from '../store/repo';
import { TERMINAL_WF, type Workflow } from '../store/types';

export function assertScaleBaseline(groups: ClusterInstanceGroupDetails[], group: string, expected: number) {
  const target = groups.find((item) => item.InstanceGroupName === group);
  if (!target) throw badRequest('연구 자원 풀을 찾지 못했습니다.');
  if ((target.TargetCount ?? target.CurrentCount ?? 0) !== expected) throw new HttpError(409, '다른 곳에서 노드 수가 변경되었습니다. 새로고침 후 다시 확인하세요.');
  return target;
}
export function assertGroupIdle(target: ClusterInstanceGroupDetails, nodes: Node[], pods: Pod[], workflows: Workflow[], instanceIds: string[]) {
  const nodeNames = new Set(nodes.filter((node) => instanceIds.some((id) => node.metadata.name === `hyperpod-${id}` || node.metadata.name.endsWith(`-${id}`))).map((node) => node.metadata.name));
  if (nodeNames.size < (target.CurrentCount ?? 0)) throw new HttpError(409, '노드와 인스턴스 연결을 확인하지 못해 축소를 중단했습니다.');
  const busy = pods.filter((pod) => !SYSTEM_NAMESPACES.has(pod.metadata.namespace ?? '') && !['Succeeded', 'Failed'].includes(pod.status?.phase ?? '') && (
    nodeNames.has(pod.spec.nodeName ?? '') || !pod.spec.nodeName
  ));
  const gpuGroup = /^ml\.(g|p)/.test(target.InstanceType ?? '');
  const active = workflows.filter((workflow) => !TERMINAL_WF.has(workflow.status) && workflow.spec.workflow.tasks.some((task) => {
    const resource = workflow.spec.workflow.resources[task.resource];
    const platform = task.platform ?? resource.platform;
    return platform ? platform === target.InstanceType : Boolean(resource.gpu) === gpuGroup;
  }));
  if (busy.length || active.length) throw new HttpError(409, '실행·대기·결과 저장 중인 작업 또는 세션이 있습니다. 완료하거나 취소한 후 노드 수를 줄이세요.', 'capacity_in_use', {
    pods: busy.slice(0, 20).map((pod) => pod.metadata.name), workflows: active.slice(0, 20).map((workflow) => workflow.id),
  });
}

/** Reject stale UI changes and inspect all pages before reducing shared capacity. */
export async function scaleChecked(name: string, group: string, count: number, expectedCount: number) {
  const initial = await hp.describeCluster(name);
  if (initial.ClusterStatus !== 'InService') throw new HttpError(409, '클러스터 변경이 진행 중입니다. 완료 후 다시 시도하세요.');
  const target = assertScaleBaseline(initial.InstanceGroups ?? [], group, expectedCount);
  if (count === expectedCount) return;
  if (count < expectedCount) {
    if (name !== config().eks?.hyperPodClusterName) throw new HttpError(409, '이 클러스터의 작업 점유 상태를 확인할 수 없어 웹에서 축소하지 않습니다.');
    const [nodes, pods, clusterNodes] = await Promise.all([listNodes(), listPods(), hp.listNodes(name)]);
    const workflows: Workflow[] = [];
    let cursor: string | undefined;
    do {
      const page = await getRepo().listWorkflowsPage({ limit: 200, cursor });
      workflows.push(...page.items.filter((workflow) => !TERMINAL_WF.has(workflow.status)));
      cursor = page.cursor;
    } while (cursor);
    assertGroupIdle(target, nodes, pods, workflows, clusterNodes.filter((node) => node.InstanceGroupName === group).map((node) => node.InstanceId!).filter(Boolean));
  }
  const fresh = await hp.describeCluster(name);
  assertScaleBaseline(fresh.InstanceGroups ?? [], group, expectedCount);
  if (fresh.ClusterStatus !== 'InService') throw new HttpError(409, '클러스터가 변경되었습니다. 새로고침 후 확인하세요.');
  await hp.scaleGroup(name, group, count, expectedCount);
}
