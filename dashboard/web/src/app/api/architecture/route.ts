import { route } from '@/server/api';
import { architectureMap } from '@/server/services/architecture';
export const dynamic = 'force-dynamic';
/** Deployed AWS resources with live status from their Describe APIs (cached 60 s server-side). */
export const GET = route('viewer', async () => architectureMap());
