import { HttpError } from '../errors';
import type { Item } from '../store/dynamo';
import type { Write } from '../store/atomic';
import type { BrokerDeps } from './broker';
import type { Plan } from './uploads';

interface Registry extends Item { ids: string[]; revision: number }
export const activeUploadKey = (workflowId: string, epoch: string, task: string) =>
  ({ pk: `WF#${workflowId}`, sk: `RUNTIME#${epoch}#UPLOAD-ACTIVE#${task}` });
export async function activeUploadWrite(deps: BrokerDeps, plan: Plan, add: boolean): Promise<Write[]> {
  if (plan.request.protocolVersion !== 2) return [];
  const epoch = plan.sk.slice('RUNTIME#'.length, plan.sk.indexOf('#UPLOAD#'));
  const task = plan.prefix.split('/').at(-3)!;
  const key = activeUploadKey(plan.pk.slice(3), epoch, task);
  const old = await deps.repo.kv.get(key.pk, key.sk) as Registry | undefined;
  if (old && (!Array.isArray(old.ids) || old.ids.length > 128 || !Number.isSafeInteger(old.revision))) {
    throw new HttpError(409, 'Invalid active checkpoint registry');
  }
  const ids = (old?.ids ?? []).filter(id => id !== plan.publicationId);
  if (add) {
    if (ids.length >= 128) throw new HttpError(409, 'Too many unfinished checkpoint publications; cleanup is required');
    ids.push(plan.publicationId);
  }
  if (!add && (!old || ids.length === old.ids.length)) return [];
  return [{ kind: 'put', item: { ...key, ids, revision: (old?.revision ?? 0) + 1 },
    condition: old ? { equals: { revision: old.revision } } : { absent: true } }];
}
export async function activeUploads(deps: BrokerDeps, workflowId: string, epoch: string, task: string): Promise<string[]> {
  const key = activeUploadKey(workflowId, epoch, task);
  const registry = await deps.repo.kv.get(key.pk, key.sk) as Registry | undefined;
  if (!registry) return [];
  if (!Array.isArray(registry.ids) || registry.ids.length > 128 ||
    registry.ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
    throw new HttpError(409, 'Invalid active checkpoint registry');
  }
  return registry.ids;
}
