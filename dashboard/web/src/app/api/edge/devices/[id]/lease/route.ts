import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { leaseClaimSchema, devicesService } from '@/server/services/devices';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ req, session, params }) => devicesService().claimLease(session, (await requestProject(req, session, 'researcher')).id, params.id, await body(req, leaseClaimSchema)), { audit: 'edge.lease.claim' });
