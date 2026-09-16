import { route } from '@/server/api';
import { overview } from '@/server/services/overview';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => overview());
