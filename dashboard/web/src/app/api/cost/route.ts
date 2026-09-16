import { route } from '@/server/api';
import { last30DaysByService } from '@/server/aws/cost';
export const dynamic = 'force-dynamic';
export const GET = route('admin', async () => last30DaysByService());
