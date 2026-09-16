import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { benchmarkSchema, devicesService } from '@/server/services/devices';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ req, session, params }) => devicesService().benchmark(session, (await requestProject(req, session, 'researcher')).id, params.id, await body(req, benchmarkSchema)), { audit: 'edge.benchmark.ingest' });
