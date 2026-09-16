import { createHash } from 'node:crypto';
import type { Task, Workflow, ArtifactReceipt } from '../store/types';
import type { TaskSpec } from './schema';
import type { ControllerDeps } from './ports';
import type { LeaseGuard } from './lease';
import { assertPathWithin } from './validation';
export function validateReceipt(result: ArtifactReceipt): void {
  if (!/^s3:\/\/[^/]+\/.+/.test(result.uri) || !/^s3:\/\/[^/]+\/.+/.test(result.manifestUri) || !/^[a-f0-9]{64}$/i.test(result.manifestHash) || !Number.isFinite(Date.parse(result.verifiedAt)) || !Number.isSafeInteger(result.objectCount) || result.objectCount < 1 || !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes < 0) throw new Error('publisher did not return a verified durable S3 manifest');
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
        tags: [],
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
