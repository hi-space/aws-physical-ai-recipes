import { route } from '@/server/api';
import { readRates, refreshRates, ensureRates } from '@/server/aws/hyperpod-rates';
import { config } from '@/server/config';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => {
  const snapshot = await ensureRates(config().region);
  return snapshot || { service: 'AmazonSageMaker', region: config().region, currency: 'USD', term: 'OnDemand', sourceUrl: '', retrievedAt: '', publicationDate: '', catalogVersion: '', sha256: '', rates: [] };
});
export const POST = route('admin', async () => refreshRates(config().region), { audit: 'usage.rates.refresh' });
