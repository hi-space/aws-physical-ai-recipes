import { route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { readBackend } from '@/server/backends/registry';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('admin', async ({ params }) => ({
  backend: await readBackend(params.id),
  revisions: (await getRepo().kv.query(`BACKEND#${params.id}`, 'REV#')).map(({ pk: _p, sk: _s, ...revision }) => revision),
}));
