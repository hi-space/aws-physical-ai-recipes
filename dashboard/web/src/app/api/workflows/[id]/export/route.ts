import { route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { notFound } from '@/server/errors';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ params }) => {
  const wf = await getRepo().getWorkflow(params.id);
  if (!wf) throw notFound(`workflow ${params.id}`);
  return new Response(wf.specYaml, { headers: { 'content-type': 'application/yaml', 'content-disposition': `attachment; filename="${wf.name}-${wf.id}.yaml"` } });
});
