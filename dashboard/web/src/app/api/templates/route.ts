import { z } from 'zod';
import { body, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { BUILTIN_TEMPLATES } from '@/server/workflow/builtin-templates';
import { parseWorkflowYaml, readDefaults } from '@/server/workflow/template';
export const dynamic = 'force-dynamic';

export const GET = route('viewer', async () => {
  const stored = await getRepo().listTemplates();
  const ids = new Set(stored.map((t) => t.id));
  return [...stored, ...BUILTIN_TEMPLATES.filter((t) => !ids.has(t.id))];
});

const schema = z.object({
  id: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(40),
  title: z.string().min(1).max(80),
  description: z.string().max(400).default(''),
  category: z.enum(['simulation', 'training', 'evaluation', 'data', 'setup', 'custom']).default('custom'),
  yaml: z.string().min(1),
  params: z.array(z.object({ name: z.string(), label: z.string(), type: z.enum(['string', 'number', 'select', 'boolean', 'text']), default: z.string().optional(), options: z.array(z.string()).optional(), help: z.string().optional() })).optional(),
});
export const POST = route('researcher', async ({ req, session }) => {
  const b = await body(req, schema);
  if (BUILTIN_TEMPLATES.some((t) => t.id === b.id)) throw new Error(`${b.id} is a built-in template id`);
  parseWorkflowYaml(b.yaml);
  const defaults = readDefaults(b.yaml);
  const params = b.params ?? Object.entries(defaults).map(([name, def]) => ({ name, label: name, type: 'string' as const, default: def }));
  const t = { ...b, params, builtin: false, createdBy: session.user, createdAt: new Date().toISOString() };
  await getRepo().putTemplate(t);
  return t;
}, { audit: 'template.save' });
