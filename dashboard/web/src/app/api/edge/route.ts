import { route } from '@/server/api';
import * as gg from '@/server/aws/greengrass';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => gg.overview());
