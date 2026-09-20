import { badRequest, forbidden, notFound } from '@/server/errors';
import { canReadResource, isProjectAdmin, resolveProject, type Project } from '@/server/auth/projects';
import type { Session } from '@/server/auth/session';
import { getRepo, type Repo } from '@/server/store/repo';
import type { Template } from '@/server/store/types';
import { BUILTIN_TEMPLATES } from '@/server/workflow/builtin-templates';
import { parseWorkflowYaml, readDefaults } from '@/server/workflow/template';

/** Optional selectedProjectId constrains project recipes; private legacy ownership still applies. */
export async function canReadTemplate(session: Session, template: Template | undefined, repo: Repo = getRepo(), selectedProjectId?: string): Promise<boolean> {
  if (!template) return false;
  if (template.builtin) return true;
  if (selectedProjectId && template.projectId && template.projectId !== selectedProjectId) return false;
  return canReadResource(session, { projectId: template.projectId, ownerSubject: template.ownerSubject, owner: template.createdBy }, repo);
}
export async function assertTemplateWrite(session: Session, template: Template, repo: Repo = getRepo()): Promise<Project | undefined> {
  if (template.builtin || BUILTIN_TEMPLATES.some(t => t.id === template.id)) throw forbidden('Built-in templates cannot be changed');
  if (!await canReadTemplate(session, template, repo)) throw notFound('template');
  const project = template.projectId ? await resolveProject(session, template.projectId, repo, 'researcher') : undefined;
  const principal = session.subject ?? session.user;
  const owner = template.ownerSubject ? template.ownerSubject === principal : template.createdBy === session.user;
  if (!owner && session.role !== 'admin' && !(project && isProjectAdmin(session, project))) throw forbidden('Only the template owner or a project/platform administrator can change it');
  return project;
}
export function parseTemplateVersion(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) >= 1e12) throw badRequest('Invalid template version');
  return Number(raw);
}
export async function ensureBuiltin(id: string, repo: Repo = getRepo()) {
  const builtin = BUILTIN_TEMPLATES.find(template => template.id === id);
  if (builtin) await repo.putTemplate(builtin);
}
export async function readTemplate(session: Session, id: string, version?: number, repo: Repo = getRepo()) {
  await ensureBuiltin(id, repo);
  const template = await repo.getTemplate(id, version);
  if (!await canReadTemplate(session, template, repo)) throw notFound('template');
  return template!;
}
const secretName = /(?:^|_)(?:token|secret|password|passwd|api_key|private_key|access_key|secret_access_key)(?:_(?:param|ref|arn))?$/i;
function secretReference(value: string): boolean {
  return /^\/(groot|pai|physical-ai)\/[A-Za-z0-9_./-]+$/.test(value) && !value.includes('..') && !value.endsWith('/') && value.split('/').slice(1).every(part => part !== '' && part !== '.');
}
/** Validation never fetches a secret and never includes a supplied value in errors. */
export function templateDefaults(yaml: string) {
  try { return readDefaults(yaml); }
  catch { throw badRequest('Invalid template YAML'); }
}
export function validateTemplateContent(yaml: string, params: Template['params']) {
  const defaults = templateDefaults(yaml);
  for (const [name, value] of Object.entries(defaults)) if (secretName.test(name) && value && !secretReference(value)) throw badRequest('Template defaults must use secret references, not secret values');
  for (const param of params) if (secretName.test(param.name) && param.default && !secretReference(param.default)) throw badRequest('Template defaults must use secret references, not secret values');
  const values = Object.fromEntries(params.filter(param => param.default !== undefined).map(param => [param.name, param.default!]));
  let parsed: ReturnType<typeof parseWorkflowYaml>;
  try { parsed = parseWorkflowYaml(yaml, values); }
  catch { throw badRequest('Invalid workflow template'); }
  for (const task of parsed.spec.workflow.tasks) {
    for (const mapping of Object.values(task.credentials)) for (const ref of Object.values(mapping)) if (!secretReference(ref)) throw badRequest('Template credentials must use approved secret references');
    for (const [name, value] of Object.entries(task.environment)) if ((secretName.test(name) || name === 'AWS_ACCESS_KEY_ID') && value) throw badRequest('Secret-valued environment fields must use credential references');
  }
}
