import { z } from 'zod';
import { body, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { createDataset } from '@/server/services/datasets';
import { filterAccessible, requestProject } from '@/server/auth/projects';
import { forbidden } from '@/server/errors';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ session, req, url }) => {
  const legacy = url.searchParams.get('legacy') === '1';
  if (legacy && session.tokenProjectId) throw forbidden('프로젝트 토큰으로 이전 개인 데이터에 접근할 수 없습니다.');
  const selected = session.tokenProjectId || req.headers.get('x-pai-project') || /(?:^|;\s*)pai-project=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  const project = !legacy && (selected || session.role !== 'admin') ? await requestProject(req, session) : undefined;
  const datasets = await getRepo().listDatasets();
  return filterAccessible(session, legacy ? datasets.filter((dataset) => !dataset.projectId) : project ? datasets.filter((dataset) => dataset.projectId === project.id) : datasets);
});
export const POST = route('researcher', async ({ req, session }) => {
  const b = await body(req, z.object({ name: z.string(), description: z.string().max(500).optional(), tags: z.array(z.string()).optional(), format: z.string().optional() }));
  return createDataset(b, session.user, await requestProject(req, session, 'researcher'), session.subject);
}, { audit: 'dataset.create' });
