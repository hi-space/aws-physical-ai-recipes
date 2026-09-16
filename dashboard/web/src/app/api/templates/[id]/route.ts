import { route } from '@/server/api';
import { forbidden, notFound } from '@/server/errors';
import { getRepo } from '@/server/store/repo';
import { BUILTIN_TEMPLATES } from '@/server/workflow/builtin-templates';
import { assertTemplateWrite, parseTemplateVersion, readTemplate } from '../_shared';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ params, session, url }) => {
  return readTemplate(session, params.id, parseTemplateVersion(url.searchParams.get('version')));
});
export const DELETE = route<{ id: string }>('researcher', async ({ params, session }) => {
  if (BUILTIN_TEMPLATES.some(template => template.id === params.id)) throw forbidden('Built-in templates cannot be deleted');
  const repo = getRepo(), template = await repo.getTemplate(params.id);
  if (!template) throw notFound('template');
  await assertTemplateWrite(session, template, repo);
  await repo.deleteTemplate(params.id, { expectedVersion: template.templateVersion });
  return { ok: true };
}, { audit: 'template.delete' });
