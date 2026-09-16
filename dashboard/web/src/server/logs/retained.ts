import { currentUserAuthorization, type CurrentUserAuthorization } from '../aws/cognito';
import { roleFromGroups } from '../auth/rbac';
import type { Session } from '../auth/session';
import type { Pod } from '../k8s/resources';
import { k8sGetOrNull, k8sRequest } from '../k8s/client';
import { HttpError } from '../errors';

interface RetainedDeps {
  user(username: string): Promise<CurrentUserAuthorization>;
  pod(namespace: string, name: string): Promise<Pod | null>;
  read(path: string, signal: AbortSignal): Promise<Response>;
}
const defaults: RetainedDeps = { user: currentUserAuthorization,
  pod: (namespace, name) => k8sGetOrNull(`/api/v1/namespaces/${namespace}/pods/${name}`),
  read: (path, signal) => k8sRequest(path, { signal, headers: { accept: '*/*' } }) };
/** Explicit administrator-only access to existing workshop Pods that predate archive registration. */
export async function retainedPodLogs(session: Session, namespace: string, name: string, url: URL, signal: AbortSignal, d: RetainedDeps = defaults) {
  async function admin() {
    if (session.role !== 'admin' || session.authMethod === 'token' || !session.subject) throw new HttpError(403, '기존 Kubernetes 로그에는 관리자 브라우저 로그인이 필요합니다.');
    const user = await d.user(session.user);
    if (!user.enabled || user.subject !== session.subject || roleFromGroups(user.groups) !== 'admin') throw new HttpError(403, '현재 관리자 권한을 확인할 수 없습니다.');
  }
  await admin();
  if (![namespace, name].every(value => /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(value))) throw new HttpError(400, 'Invalid Pod identity');
  const pod = await d.pod(namespace, name);
  if (!pod?.metadata.uid || pod.metadata.namespace !== namespace || pod.metadata.name !== name) throw new HttpError(404, 'Pod가 없어 현재 Kubernetes 로그를 조회할 수 없습니다.');
  const container = url.searchParams.get('container') ?? pod.spec.containers[0]?.name;
  if (!container || ![...pod.spec.containers, ...(pod.spec.initContainers ?? [])].some(value => value.name === container)) throw new HttpError(404, 'Container not found');
  const state = (value: Pod) => [...(value.status?.containerStatuses ?? []), ...(value.status?.initContainerStatuses ?? [])]
    .find(status => status.name === container)?.restartCount;
  const restartCount = state(pod);
  const tail = Number(url.searchParams.get('tail') ?? 1000);
  if (!Number.isSafeInteger(tail) || tail < 1 || tail > 2000) throw new HttpError(400, 'tail must be 1–2000');
  const query = new URLSearchParams({ container, tailLines: String(tail), limitBytes: String(1024 * 1024), timestamps: 'true' });
  let text: string;
  try {
    const response = await d.read(`/api/v1/namespaces/${namespace}/pods/${name}/log?${query}`, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    if (!response.body || !response.ok) throw new Error('retained source unavailable');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let count = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        count += next.value.byteLength;
        if (count > 1024 * 1024) throw new Error('retained source exceeded bound');
        chunks.push(next.value);
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { await reader.cancel().catch(() => undefined); }
  } catch { throw new HttpError(502, '현재 Kubernetes 로그를 읽지 못했습니다. 보관 이력으로 대체하지 않았습니다.', 'retained_logs_unavailable'); }
  const current = await d.pod(namespace, name);
  if (!current || current.metadata.uid !== pod.metadata.uid || state(current) !== restartCount) {
    throw new HttpError(409, '조회 중 Pod 또는 컨테이너 시도가 바뀌었습니다. 다시 선택하세요.', 'retained_log_identity_changed');
  }
  await admin();
  return { source: 'kubernetes-retained', coverage: 'retained-only', redaction: 'unavailable',
    podUid: pod.metadata.uid, container, restartCount, phase: current.status?.phase, lines: text.split('\n') };
}
