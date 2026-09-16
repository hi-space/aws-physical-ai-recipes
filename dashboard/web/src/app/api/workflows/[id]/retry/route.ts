import { route } from '@/server/api';
import { retryWorkflow, submitWorkflow } from '@/server/workflow/controller';
import { productionControllerDeps } from '@/server/workflow-adapters/dependencies';
import { NextResponse } from 'next/server';
import { getRepo } from '@/server/store/repo';
import { requestProject, resolveProject } from '@/server/auth/projects';
import { HttpError, notFound } from '@/server/errors';
import { assertCredentialUse } from '@/server/services/credentials';
import { profilesRequired } from '@/server/services/profile-binding';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ params, session, req }) => {
  const original = await getRepo().getWorkflow(params.id);
  if (!original) throw notFound('workflow');
  if (profilesRequired() && !original.imagePins) throw new HttpError(428, '이전 실행을 복제하고 현재 이미지 프로필을 검토한 뒤 제출하세요.', 'image_preflight_review');
  const project = original.projectId ? undefined : await requestProject(req, session, 'researcher');
  const credentialProject = project ?? await resolveProject(session, original.projectId, getRepo(), 'researcher');
  for (const task of original.spec.workflow.tasks) {
    for (const references of Object.values(task.credentials)) for (const reference of Object.values(references)) await assertCredentialUse(session, credentialProject, reference);
  }
  const workflow = project
    ? await submitWorkflow({ yaml: original.specYaml, overrides: original.vars, owner: session.user, ownerSubject: session.subject, projectId: project.id, namespace: project.namespace, queue: project.queue, deferLaunch: true }, productionControllerDeps())
    : await retryWorkflow(params.id, session.user, productionControllerDeps(), session.subject ? { ownerSubject: session.subject } : undefined);
  return NextResponse.json(workflow, { status: 202 });
}, { audit: 'workflow.retry' });
