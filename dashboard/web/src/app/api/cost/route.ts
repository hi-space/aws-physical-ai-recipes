import { NextResponse } from 'next/server';
import { route } from '@/server/api';
import { cachedAccountCost } from '@/server/aws/cost';
export const dynamic = 'force-dynamic';
export const GET = route('admin', async () =>
  NextResponse.json(await cachedAccountCost(), { headers: { 'cache-control': 'private, max-age=600' } }));
