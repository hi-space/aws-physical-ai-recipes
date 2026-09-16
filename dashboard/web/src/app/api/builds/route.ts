import { z } from 'zod';
import { body, q, route } from '@/server/api';
import { listBuildProjects, listBuilds, startBuild } from '@/server/services/builds';
export const dynamic = 'force-dynamic';
export const GET = route('admin', async ({ url }) => q(url, 'project') ? listBuilds(q(url, 'project')!) : listBuildProjects());
export const POST = route('admin', async ({ req, session }) => {
  const input = await body(req, z.object({ project: z.string() }).strict());
  return startBuild(input.project, session.subject ?? session.user, req.headers.get('idempotency-key') ?? undefined);
}, { audit: 'build.start' });
