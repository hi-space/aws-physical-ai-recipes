import { route } from '@/server/api';
import { badRequest, notFound } from '@/server/errors';
import { assertOwner } from '@/server/auth/session';
import { getRepo } from '@/server/store/repo';
import { BUILTIN_TEMPLATES } from '@/server/workflow/builtin-templates';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ params }) => {
  const t = (await getRepo().getTemplate(params.id)) ?? BUILTIN_TEMPLATES.find((x) => x.id === params.id);
  if (!t) throw notFound(`template ${params.id}`);
  return t;
});
export const DELETE = route<{ id: string }>('researcher', async ({ params, session }) => {
  if (BUILTIN_TEMPLATES.some((t) => t.id === params.id)) throw badRequest('built-in templates cannot be deleted');
  const t = await getRepo().getTemplate(params.id);
  if (!t) throw notFound(`template ${params.id}`);
  assertOwner(session, t.createdBy, 'template');
  await getRepo().deleteTemplate(params.id);
  return { ok: true };
}, { audit: 'template.delete' });
