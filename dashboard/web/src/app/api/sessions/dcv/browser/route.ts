import { z } from 'zod';
import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { configureDcvHost, createDcvBrowserSession, dcvRegistration, reconcileDcvSetup } from '@/server/dcv/sessions';
import { getRepo } from '@/server/store/repo';
export const dynamic = 'force-dynamic';
export const GET = route('admin', async () => {
  await reconcileDcvSetup();
  const registered = await dcvRegistration();
  const setup = await getRepo().kv.get('SYS', 'DCV_SETUP');
  return { configured: Boolean(registered) && !setup, configuredAt: registered?.configuredAt, status: setup?.failed ? 'FAILED' : setup ? 'CONFIGURING' : undefined, error: setup?.failed ? 'DCV 연결 준비에 실패했습니다. 워크스테이션 상태를 확인하고 다시 시도하세요.' : undefined };
});
export const POST = route('admin', async ({ req, session }) => {
  const input = await body(req, z.object({ action: z.enum(['configure', 'create']), ttlMinutes: z.number().int().min(5).max(240).optional() }));
  if (input.action === 'configure') return configureDcvHost();
  const project = await requestProject(req, session, 'researcher');
  const created = await createDcvBrowserSession(session, project.id, input.ttlMinutes);
  return { id: created.id, status: created.status, expiresAt: created.expiresAt };
}, { audit: 'dcv.browser' });
