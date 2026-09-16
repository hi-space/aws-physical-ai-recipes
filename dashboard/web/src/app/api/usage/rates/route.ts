import { route } from '@/server/api';
import { readRates, refreshRates } from '@/server/aws/hyperpod-rates';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => readRates());
export const POST = route('admin', async () => refreshRates(), { audit: 'usage.rates.refresh' });
