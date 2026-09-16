import { z } from 'zod';
import { body, q, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { submitWorkflow } from '@/server/workflow/controller';
export const dynamic = 'force-dynamic';

export const GET = route('viewer', async ({ url }) => {
  const status = q(url, 'status');
  const owner = q(url, 'owner');
  const ns = q(url, 'namespace');
  const search = q(url, 'q')?.toLowerCase();
  let list = await getRepo().listWorkflows({ limit: 300 });
  if (status) list = list.filter((w) => w.status === status);
  if (owner) list = list.filter((w) => w.owner === owner);
  if (ns) list = list.filter((w) => w.namespace === ns);
  if (search) list = list.filter((w) => w.name.includes(search) || w.id.includes(search) || w.owner.toLowerCase().includes(search));
  return list.map(({ spec: _spec, specYaml: _y, ...w }) => w);
});

const submitSchema = z.object({ yaml: z.string().min(1), overrides: z.record(z.string(), z.string()).optional(), templateId: z.string().optional(), namespace: z.string().optional() });
export const POST = route('researcher', async ({ req, session }) => {
  const b = await body(req, submitSchema);
  return submitWorkflow({ ...b, owner: session.user });
}, { audit: 'workflow.submit' });
