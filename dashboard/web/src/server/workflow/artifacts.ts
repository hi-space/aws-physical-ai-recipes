import { createHash } from 'node:crypto';
import YAML from 'yaml';
import type { Task, Workflow, ArtifactReceipt } from '../store/types';
import type { TaskSpec } from './schema';
import type { ControllerDeps } from './ports';
import type { LeaseGuard } from './lease';
import { assertPathWithin } from './validation';
export function validateReceipt(result: ArtifactReceipt): void {
  if (!/^s3:\/\/[^/]+\/.+/.test(result.uri) || !/^s3:\/\/[^/]+\/.+/.test(result.manifestUri) || !/^[a-f0-9]{64}$/i.test(result.manifestHash) || !Number.isFinite(Date.parse(result.verifiedAt)) || !Number.isSafeInteger(result.objectCount) || result.objectCount < 1 || !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes < 0) throw new Error('publisher did not return a verified durable S3 manifest');
}
/**
 * A recorded fact, not a guess: if the published dataset's name is `<outputName>-<workflowId>` and
 * `<outputName>` matches one of the workflow's own recipe metadata `ports.outputs[].name` entries
 * (embedded under `ui.recipe` in the stored spec YAML, same shape as `getRecipeMetadata` in
 * builtin-templates.ts), tag the dataset with that output's declared port kind. Custom recipes or
 * recipes without a matching port simply get no tag.
 */
export function outputKindTag(wf: Workflow, datasetName: string): string[] {
  const suffix = `-${wf.id}`;
  if (!datasetName.endsWith(suffix)) return [];
  const outputName = datasetName.slice(0, -suffix.length);
  try {
    const doc = YAML.parse(wf.specYaml) as { ui?: { recipe?: { ports?: { outputs?: { name: string; kind: string }[] } } } } | null;
    const match = doc?.ui?.recipe?.ports?.outputs?.find(o => o.name === outputName);
    return match ? [`kind:${match.kind}`] : [];
  } catch {
    return [];
  }
}
export async function finalizeTask(wf: Workflow, ts: TaskSpec, task: Task, deps: ControllerDeps, guard: LeaseGuard): Promise<Task> {
  if (!ts.outputs.length) return {
    ...task,
    phase: 'SUCCEEDED',
    finishedAt: deps.now().toISOString(),
    message: task.ignoredByGroupPolicy ? 'Nonleader failure ignored by group policy; observedPhase retains the workload failure' : undefined
  };
  if (!deps.artifactPublisher) return {
    ...task,
    phase: 'FINALIZING',
    message: 'Artifact publisher is not configured; durable outputs are not verified'
  };
  const receipts = {
    ...task.artifactReceipts
  };
  const published = [...(task.publishedVersions ?? [])];
  for (const [index, output] of ts.outputs.entries()) {
    const id = createHash('sha256').update(`${wf.id}:${task.name}:${task.attempts}:${index}`).digest('hex');
    let receipt = receipts[id];
    if (!receipt) {
      const sourcePath = ('dataset' in output ? output.dataset.path : output.logs).replace(/\{\{\s*output\s*\}\}/g, task.outputPath ?? '').replace(/\/$/, '');
      assertPathWithin(sourcePath, task.outputPath!);
      await guard.check();
      const result = await deps.artifactPublisher.publish({
        workflow: wf,
        task,
        output,
        sourcePath,
        publicationId: id,
        attempt: task.attempts,
        signal: guard.signal
      });
      await guard.check();
      if (result.state === 'pending') return {
        ...task,
        artifactReceipts: receipts,
        publishedVersions: published,
        phase: 'FINALIZING',
        message: result.message ?? 'Waiting for artifact publication'
      };
      validateReceipt(result);
      receipt = result;
      receipts[id] = receipt;
    }
    if ('dataset' in output && !published.some(v => v.dataset === output.dataset.name)) {
      const now = deps.now().toISOString();
      const version = await deps.repo.publishDatasetVersion({
        name: output.dataset.name,
        owner: wf.owner,
        ownerSubject: wf.ownerSubject,
        projectId: wf.projectId,
        tags: outputKindTag(wf, output.dataset.name),
        latestVersion: 0,
        createdAt: now,
        updatedAt: now
      }, {
        dataset: output.dataset.name,
        ...receipt,
        fsxPath: output.dataset.path.replace(/\{\{\s*output\s*\}\}/g, task.outputPath!),
        tags: [],
        producedBy: {
          workflowId: wf.id,
          task: task.name
        },
        producedAttempt: task.attempts,
        createdAt: now,
        createdBy: wf.owner,
        note: output.dataset.note,
        state: 'READY'
      }, id, guard.lease);
      published.push({
        dataset: version.dataset,
        version: version.version
      });
      await deps.repo.appendEvent({
        workflowId: wf.id,
        ts: now,
        type: 'info',
        source: 'controller',
        reason: 'DatasetPublished',
        message: `published ${version.dataset} v${version.version}`,
        task: task.name
      });
    }
    task = {
      ...task,
      artifactReceipts: receipts,
      publishedVersions: published
    };
    await deps.repo.putTask(task, guard.lease);
  }
  return {
    ...task,
    phase: 'SUCCEEDED',
    finishedAt: deps.now().toISOString(),
    message: undefined
  };
}
