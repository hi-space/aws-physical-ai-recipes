import { z } from 'zod';
import { body, q, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { submitWorkflow } from '@/server/workflow/controller';
import { requestProject } from '@/server/auth/projects';
import { listMatchingWorkflows } from '@/server/services/workflow-list';
import { productionControllerDeps } from '@/server/workflow-adapters/dependencies';
import { parseWorkflowYaml } from '@/server/workflow/template';
import { badRequest, forbidden } from '@/server/errors';
import { NextResponse } from 'next/server';
import { assertCredentialUse } from '@/server/services/credentials';
import { canReadTemplate, readTemplate } from '@/app/api/templates/_shared';
import { acceptedImagePins, inspectWorkflowImages, profilesRequired } from '@/server/services/profile-binding';
import { executionProfilesService } from '@/server/services/execution-profiles';
export const dynamic = 'force-dynamic';

export const GET = route('viewer', async ({ url, session, req }) => {
  const selected = session.tokenProjectId || req.headers.get('x-pai-project') || /(?:^|;\s*)pai-project=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  const project = selected || session.role !== 'admin' ? await requestProject(req, session) : undefined;
  const paged = q(url, 'page') === '1';
  const page = await listMatchingWorkflows(session, {
    limit: paged ? 50 : 200, projectId: project?.id, cursor: q(url, 'cursor'),
    status: q(url, 'status'), owner: q(url, 'owner'), namespace: q(url, 'namespace'), search: q(url, 'q'),
  }, getRepo());
  const items = page.items.map(({ spec: _spec, specYaml: _y, ...workflow }) => workflow);
  if (paged) return { ...page, items };
  const headers: Record<string, string> = {
    'x-workflow-search-exhausted': String(page.exhausted),
    'x-workflow-scan-limited': String(page.scanLimited),
  };
  if (page.cursor) {
    const next = new URLSearchParams(url.searchParams);
    next.set('cursor', page.cursor);
    headers.link = `<${url.pathname}?${next}>; rel="next"`;
    headers['x-workflow-cursor'] = page.cursor;
  }
  // Legacy array consumers must not mistake an incomplete empty window for no matches.
  if (page.scanLimited && !items.length) return NextResponse.json({
    error: page.message, code: 'workflow_search_incomplete', cursor: page.cursor,
    scanLimited: true, exhausted: false,
  }, { status: 409, headers });
  return NextResponse.json(items, { headers });
});

const submitSchema = z.object({ yaml: z.string().min(1), overrides: z.record(z.string(), z.string()).optional(), templateId: z.string().optional(), templateVersion: z.number().int().positive().optional(), namespace: z.string().optional(), acknowledgePreflight: z.boolean().optional() });
export const POST = route('researcher', async ({ req, session }) => {
  const b = await body(req, submitSchema);
  const project = await requestProject(req, session, 'researcher');
  const template = b.templateId ? await readTemplate(session, b.templateId, b.templateVersion) : undefined;
  if (template && !await canReadTemplate(session, template, getRepo(), project.id)) throw forbidden('다른 프로젝트의 템플릿입니다.');
  if (b.templateVersion && !b.templateId) throw badRequest('템플릿 버전에는 templateId가 필요합니다.');
  const parsed = parseWorkflowYaml(b.yaml, b.overrides);
  if (parsed.spec.workflow.tasks.some((task) => task.image.startsWith('required://'))) throw badRequest('실행 이미지를 먼저 준비해 주세요.');
  for (const task of parsed.spec.workflow.tasks) {
    for (const references of Object.values(task.credentials)) for (const reference of Object.values(references)) await assertCredentialUse(session, project, reference);
  }
  if (session.role !== 'admin') {
    for (const task of parsed.spec.workflow.tasks) {
      if (task.volumes.length) throw forbidden('Host mounts require an administrator-managed session');
    }
  }
  const imagePins = profilesRequired()
    ? acceptedImagePins(await inspectWorkflowImages(session, parsed.spec, project), b.acknowledgePreflight === true)
    : undefined;
  const executionSpec = structuredClone(parsed.spec);
  if (imagePins) for (const task of executionSpec.workflow.tasks) task.image = imagePins[task.name]?.image ?? task.image;
  const executionProfilePins = await executionProfilesService(session).bind(executionSpec, project);
  const wf = await submitWorkflow({
    ...b, owner: session.user, ownerSubject: session.subject, projectId: project.id,
    ...(Object.keys(executionProfilePins).length ? { executionProfilePins } : {}),
    templateVersion: template?.templateVersion,
    templateContentHash: template?.contentHash,
    templateModified: template ? b.yaml.trim() !== template.yaml.trim() : undefined,
    ...(imagePins ? { imagePins, preflightReviewedBy: session.subject, preflightReviewedAt: new Date().toISOString() } : {}),
    namespace: project.namespace, queue: project.queue, backendId: project.backendId, backendConfigHash: project.backendConfigHash,
    idempotencyKey: req.headers.get('idempotency-key') ?? undefined, deferLaunch: true,
  }, productionControllerDeps());
  return NextResponse.json({ ...wf, operationId: wf.id, runId: wf.id }, { status: 202 });
}, { audit: 'workflow.submit' });
