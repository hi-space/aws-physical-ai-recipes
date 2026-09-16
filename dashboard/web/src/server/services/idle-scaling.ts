import { getRepo, type Repo } from '../store/repo';
import { runOnBackend } from '../backends/context';
import type { BackendBinding } from '../backends/registry';
import { executeScalePlan, planScale, reconcileScale, scaleSnapshot, scalingDeps, type ScalingDeps, type ScalingPolicy } from './scaling-plans';

type Runner = <T>(binding: BackendBinding, mode: 'execute' | 'observe', action: () => Promise<T>) => Promise<T>;
export interface IdleScalingDeps {
  repo: Repo; run: Runner; scaling(): ScalingDeps;
}
const defaults = (): IdleScalingDeps => ({
  repo: getRepo(),
  run: (binding, mode, action) => runOnBackend(binding, action, getRepo(), () => new Date(), mode),
  scaling: scalingDeps,
});
/** Only explicit admin opt-in policies execute. No discovery/configuration implies no capacity calls. */
export async function idleScalingTick(signal?: AbortSignal, d = defaults()) {
  const results: Array<{ cluster: string; group?: string; status: string }> = [];
  // Complete/partially failed operations keep their original backend binding even if disabled.
  for (const discovered of await d.repo.kv.queryGsi1('TYPE#SCALING_OPERATION')) {
    if (signal?.aborted) return results;
    const active = await d.repo.kv.get(discovered.pk, discovered.sk); if (!active) continue;
    try {
      const result = await d.run(active as BackendBinding, 'observe', () => reconcileScale(String(active.cluster), String(active.id), d.scaling()));
      results.push({ cluster: String(active.cluster), status: result.status });
    } catch { results.push({ cluster: String(active.cluster), status: 'UNKNOWN' }); }
  }
  for (const discovered of await d.repo.kv.queryGsi1('TYPE#SCALING_POLICY')) {
    if (signal?.aborted) return results;
    const current = await d.repo.kv.get(discovered.pk, discovered.sk) as unknown as ScalingPolicy | undefined;
    if (!current?.idleEnabled) continue;
    try {
      const result = await d.run(current, 'execute', async () => {
        const scaling = d.scaling(), snapshot = await scaleSnapshot(current.cluster, current.group, scaling);
        if (!snapshot.idleEligible || snapshot.blockers.length || snapshot.targetCount === undefined || snapshot.targetCount <= snapshot.floor) return 'BLOCKED';
        const reviewed = await planScale(current.cluster, { group: current.group, count: snapshot.floor, expectedCount: snapshot.targetCount,
          observedSpecHash: snapshot.specHash, mode: 'idle' }, current.updatedBy, scaling);
        if (reviewed.status !== 'PLANNED') return 'BLOCKED';
        if (signal?.aborted) return 'BLOCKED';
        return (await executeScalePlan(current.cluster, reviewed.plan.id, current.updatedBy, scaling)).status;
      });
      results.push({ cluster: current.cluster, group: current.group, status: result });
    } catch { results.push({ cluster: current.cluster, group: current.group, status: 'UNKNOWN' }); }
  }
  return results;
}
