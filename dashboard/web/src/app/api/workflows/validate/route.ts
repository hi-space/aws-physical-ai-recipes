import { z } from 'zod';
import { body, route } from '@/server/api';
import { HttpError } from '@/server/errors';
import { parseWorkflowYaml } from '@/server/workflow/template';
import { compileTask } from '@/server/workflow/compile';
import { topoOrder } from '@/server/workflow/schema';
import { requestProject } from '@/server/auth/projects';
import { snapshotDataset } from '@/server/workflow/submission';
import { getRepo } from '@/server/store/repo';
import { compileGroup } from '@/server/workflow/groups';
import type { CompileContext } from '@/server/workflow/compile';
import { inspectWorkflowImages, profilesRequired } from '@/server/services/profile-binding';
import { productionTopologyInventory } from '@/server/workflow-adapters/topology';
import { planTopology } from '@/server/workflow/topology/planner';
import type { Workflow } from '@/server/store/types';
import { executionProfilesService } from '@/server/services/execution-profiles';
export const dynamic = 'force-dynamic';

export const POST = route('viewer', async ({ req, session }) => {
  const b = await body(req, z.object({ yaml: z.string(), overrides: z.record(z.string(), z.string()).optional() }));
  try {
    const { spec, vars } = parseWorkflowYaml(b.yaml, b.overrides ?? {});
    const project = await requestProject(req, session);
    const ns = project.namespace;
    spec.workflow.namespace = ns;
    spec.workflow.queue = project.queue;
    const missing = spec.workflow.tasks.filter((task) => task.image.startsWith('required://'));
    if (missing.length) return { ok: false, error: `실행 이미지가 준비되지 않았습니다: ${missing.map((task) => task.image.slice(11)).join(', ')}` };
    const preflight = profilesRequired() ? await inspectWorkflowImages(session, spec, project) : undefined;
    if (preflight?.status === 'blocked') return { ok: false, error: '이미지 승인 또는 실행 환경 조건을 확인하세요.', preflight };
    if (preflight) for (const task of spec.workflow.tasks) task.image = preflight.resolvedImageDigests[task.name] ?? task.image;
    const executionProfilePins = await executionProfilesService(session).bind(spec, project);
    for (const group of spec.workflow.groups ?? []) group.tasks = group.tasks.map((task) => spec.workflow.tasks.find((item) => item.name === task.name)!);
    if (!process.env.TASK_RUNTIME_IMAGE) return { ok: false, error: '작업 실행 런타임이 아직 배포되지 않았습니다.' };
    const contexts: Record<string, CompileContext> = {};
    for (const task of spec.workflow.tasks) {
      const datasetPathsByInput: Record<number, string> = {};
      for (const [index, input] of task.inputs.entries()) if ('dataset' in input) {
        const dataset = await getRepo().getDataset(input.dataset.name);
        if (dataset?.projectId !== project.id) throw new HttpError(403, '프로젝트에서 사용할 수 없는 데이터셋입니다.');
        datasetPathsByInput[index] = (await snapshotDataset(getRepo(), input.dataset.name, input.dataset.version)).fsxPath;
      }
      contexts[task.name] = {
        executionProfile: executionProfilePins[task.name],
        workflowId: 'preview0000000000', owner: session.user, namespace: ns, projectId: project.id, backendId: project.backendId,
        artifactBucket: process.env.DASHBOARD_ARTIFACT_BUCKET,
        queue: project.queue, priority: spec.workflow.priority, attempt: 1, epoch: 'preview-epoch',
        runtimeImage: process.env.TASK_RUNTIME_IMAGE, runtimeCommand: '/opt/pai/runtime',
        runtimeEnvironment: { PAI_RUNTIME_ENDPOINT: 'http://runtime.internal', PAI_RUNTIME_TOKEN: '<generated-at-execution>' },
        datasetPathsByInput, datasetPaths: {},
        credentialValues: Object.fromEntries(Object.entries(task.credentials).map(([key, values]) => [key, Object.fromEntries(Object.keys(values).map((name) => [name, '<redacted>']))])),
      };
    }
    const grouped = new Set(spec.workflow.groups?.flatMap((group) => group.tasks.map((task) => task.name)) ?? []);
    const units = [...(spec.workflow.groups ?? []).map(group => group.tasks),
      ...spec.workflow.tasks.filter(task => !grouped.has(task.name)).map(task => [task])];
    const topologyUnits = units.filter(tasks => tasks.some(task => spec.workflow.resources[task.resource]?.topology?.length));
    if (topologyUnits.length) {
      const now = new Date();
      const preview: Workflow = {
        id: 'preview0000000000', name: spec.workflow.name, projectId: project.id, backendId: project.backendId,
        namespace: ns, owner: session.user, ownerSubject: session.subject, status: 'PENDING',
        spec, specYaml: b.yaml, vars, createdAt: now.toISOString(), updatedAt: now.toISOString(),
        taskCount: spec.workflow.tasks.length, succeededCount: 0, failedCount: 0,
      };
      const inventory = await productionTopologyInventory(preview, req.signal);
      for (const tasks of topologyUnits) {
        const placement = planTopology({ spec, tasks, inventory, namespace: ns, queue: project.queue,
          workflowId: preview.id, epoch: 'preview-epoch', now: new Date() });
        for (const task of tasks) contexts[task.name].topologyPlan = placement;
      }
    }
    const manifests = [
      ...(spec.workflow.groups ?? []).map((group) => compileGroup(spec, group, contexts[group.tasks[0].name], 'preview-epoch', contexts).jobSet),
      ...spec.workflow.tasks.filter((task) => !grouped.has(task.name)).map((task) => compileTask(spec, task, contexts[task.name]).job),
    ];
    return { ok: true, vars, preflight, order: topoOrder(spec), tasks: spec.workflow.tasks.map((t) => ({ name: t.name, resource: spec.workflow.resources[t.resource], image: t.image, inputs: t.inputs, outputs: t.outputs, parallelism: t.parallelism })), manifests };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, error: e.message, details: e.details };
    return { ok: false, error: e instanceof Error ? e.message : '실행 구성을 검증하지 못했습니다.' };
  }
});
