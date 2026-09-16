import { route } from '@/server/api';
import { trackingAccess } from '@/server/services/tracking-access';
export const dynamic = 'force-dynamic';
// Explicit legacy/admin context. Ordinary selected-project experiment views never call this.
export const GET = route('admin', async ({ session }) => trackingAccess().legacyModels(session));
