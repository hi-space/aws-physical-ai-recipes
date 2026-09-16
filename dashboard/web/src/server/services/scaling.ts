import type { ClusterInstanceGroupDetails } from '@aws-sdk/client-sagemaker';
import { HttpError, badRequest } from '../errors';
import type { Node, Pod } from '../k8s/resources';
import { SYSTEM_NAMESPACES } from '../k8s/client';
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

/** Legacy count-only calls cannot bypass reviewed plans and the cluster operation lock. */
export async function scaleChecked(_name: string, _group: string, _count: number, _expectedCount: number) {
  throw new HttpError(428, '새 관측값으로 용량 변경 계획을 검토한 뒤 planId로 실행하세요.', 'scale_plan_required');
}
export { scaleSnapshot, saveScalingPolicy, planScale, executeScalePlan, reconcileScale } from './scaling-plans';
