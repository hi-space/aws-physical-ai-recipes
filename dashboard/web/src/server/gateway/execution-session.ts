import { currentUserAuthorization } from '../aws/cognito';
import { roleFromGroups } from '../auth/rbac';
import { getRepo } from '../store/repo';
import { getPod } from '../k8s/resources';
import { runOnBackend } from '../backends/context';
import { validateExecutionProfile } from '../services/execution-profiles';
import { hasTokenBinding, type GatewayPrincipal } from './token-grants';
import { GatewayError, type AuthOptions, type GatewaySession } from './types';
const deny = () => new GatewayError(403, 'Trusted execution session approval is not current');
/** A running Pod alone is not evidence that the runtime accepted its approved user process. */
export async function authorizeExecutionSession(s: GatewaySession, options: AuthOptions, principal?: GatewayPrincipal) {
  if (!s.workflowId || !s.taskName || s.kind === 'dcv') return;
  const repo = options.repo ?? getRepo(), wf = await repo.getWorkflow(s.workflowId);
  const spec = wf?.spec?.workflow?.tasks?.find(t => t.name === s.taskName);
  if (!wf) return; // General session auth separately rejects missing workflows.
  const pins = wf.executionProfilePins;
  if (!s.trustedExecution && !spec?.executionProfile && !Object.keys(pins ?? {}).length) return;
  if (!spec || s.trustedExecution && !Object.keys(pins ?? {}).length) throw deny();
  if (hasTokenBinding(s) || s.authMethod !== 'alb' || principal && (principal.authMethod !== 'alb' || principal.role !== 'admin' || principal.tokenId || principal.tokenProjectId)) throw deny();
  if (!s.podUid || !s.podName || !s.nodeName || !s.attemptEpoch || !Number.isSafeInteger(s.attempt) || wf.ownerSubject !== s.ownerSubject || wf.projectId !== s.projectId || wf.namespace !== s.namespace || wf.status !== 'RUNNING') throw deny();
  let user;
  try { user = await (options.currentUser ?? currentUserAuthorization)(wf.owner); }
  catch { throw new GatewayError(503, 'Trusted execution identity is unavailable'); }
  if (!user.enabled || user.subject !== s.ownerSubject || roleFromGroups(user.groups) !== 'admin') throw deny();
  const checkRuntime = async () => {
    const [task, member, meta, fence, cancellation] = await Promise.all([
      repo.kv.get(`WF#${wf.id}`, `TASK#${s.taskName}`),
      repo.kv.get(`WF#${wf.id}`, `RUNTIME#${s.attemptEpoch}#MEMBER#${s.taskName}#${s.replicaIndex ?? 0}`),
      repo.kv.get(`WF#${wf.id}`, `RUNTIME#${s.attemptEpoch}#META`),
      repo.kv.get(`WF#${wf.id}`, `FENCE#${s.attemptEpoch}`), repo.cancellation(wf.id),
    ]);
    const group = wf.spec.workflow.groups?.find(g => g.tasks.some(t => t.name === s.taskName));
    if (fence || cancellation || task?.phase !== 'RUNNING' || task.attempts !== s.attempt || task.attemptEpoch !== s.attemptEpoch ||
      member?.phase !== 'RUNNING' || member.processStarted !== true || member.readyEver !== true || meta?.stopped ||
      (group?.barrier !== false && meta?.released !== true)) throw deny();
  };
  await checkRuntime();
  await runOnBackend(wf, async () => {
    await (options.validateExecutionProfile ?? validateExecutionProfile)(wf, spec);
    const pod = await (options.getPod ?? getPod)(s.namespace, s.podName!);
    const labels = pod?.metadata.labels;
    const pin = pins?.[spec.name];
    if (!pod || pod.status?.phase !== 'Running' || pod.metadata.uid !== s.podUid || pod.metadata.deletionTimestamp || pod.spec.nodeName !== s.nodeName ||
      labels?.['pai.aws/workflow-id'] !== wf.id || labels?.['pai.aws/task'] !== spec.name ||
      labels?.['pai.aws/attempt'] !== String(s.attempt) || labels?.['pai.aws/epoch'] !== s.attemptEpoch ||
      Number(labels?.['batch.kubernetes.io/job-completion-index'] ?? 0) !== (s.replicaIndex ?? 0) ||
      !pod.spec.containers.some(c => c.name === s.container) || pin && !pin.nodes.some(n => n.name === s.nodeName)) throw deny();
    if (s.kind !== 'terminal' && (pin?.policy.hostNetwork || (pod.spec as { hostNetwork?: boolean }).hostNetwork)) throw deny();
  }, repo, () => new Date((options.now ?? Date.now)()), 'observe');
  await checkRuntime();
}
