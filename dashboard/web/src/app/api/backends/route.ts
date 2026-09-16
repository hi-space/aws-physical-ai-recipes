import { body, route } from '@/server/api';
import { config } from '@/server/config';
import { backendRegistration, configuredBackends, readBackend, registerBackend } from '@/server/backends/registry';
export const dynamic = 'force-dynamic';
export const GET = route('admin', async () => ({
  default: { id: 'default', kind: 'eks', configured: !!config().eks, clusterName: config().eks?.eksClusterName, legacy: true },
  backends: await Promise.all(configuredBackends().map(async profile => {
    try { return await readBackend(profile.id); }
    catch { return { id: profile.id, status: 'UNREADY', findings: [{ code: 'unsupported_target', message: '지원하는 계정·리전·VPC 설정을 확인하세요.' }] }; }
  })),
}));
export const POST = route('admin', async ({ req, session }) => registerBackend(session, await body(req, backendRegistration)), { audit: 'backend.register' });
