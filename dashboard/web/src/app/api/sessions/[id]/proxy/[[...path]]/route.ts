import { route } from '@/server/api';
export const dynamic = 'force-dynamic';
// A notebook/user application must never execute JavaScript on the dashboard origin.
const handle = route('viewer', async () => new Response(JSON.stringify({ error: 'Use the authenticated session launch endpoint on the isolated app host' }), {
  status: 410, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
}));
export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH, handle as HEAD, handle as OPTIONS };
