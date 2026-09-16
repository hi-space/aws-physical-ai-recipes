import { test, expect } from './researcher-helpers/fixture';
import { producerWorkflow } from './researcher-helpers/workflows';
test.use({ screenshot: 'off', trace: 'off', video: 'off' });
test('inspect deployed workflow preflight findings', async ({ researcher }) => {
  const workflow = producerWorkflow(await researcher.recipe(), researcher.tag);
  const result = await researcher.api<{ ok: boolean; error?: string; preflight?: { findings: unknown[]; resolvedImageDigests?: unknown } }>('POST', '/api/workflows/validate', { yaml: workflow.yaml });
  console.log(JSON.stringify({ ok: result.ok, error: result.error, findings: result.preflight?.findings, imagePins: result.preflight?.resolvedImageDigests }));
  expect(result.ok).toBe(true);
});
