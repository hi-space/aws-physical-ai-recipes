import { test, expect, requireCondition } from './researcher-helpers/fixture';
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

test('deployment administrator inspects and approves the configured researcher images', async ({ researcher }, info) => {
  test.setTimeout(10 * 60_000);
  requireCondition(researcher.principal.role === 'admin', 'Image bootstrap requires the deployment administrator');
  const seeded = await researcher.api<{ findings: Array<{ code: string; message: string }> }>('POST', '/api/image-profiles/seed', {}, [200], 120_000);
  expect(seeded.findings, 'Every configured image must pass actual ECR inspection').toEqual([]);
  const list = await researcher.api<{ profiles: Array<{ id: string; name: string; version: number; approved: boolean; requirements: Record<string, unknown>; image: { requestedImage: string; resolvedImage: string; architectures: string[] } }> }>('GET', '/api/image-profiles');
  const desired = JSON.parse(process.env.DASHBOARD_DEPLOYED_IMAGES ?? '{}') as Record<string, string>;
  const ids = ['builtin-mujoco', 'builtin-isaaclab', 'builtin-ros2', 'builtin-groot', 'builtin-openpi', 'builtin-workspace', 'builtin-runtime'];
  const evidence = [];
  for (const id of ids) {
    const candidate = list.profiles.find((profile) => profile.id === id);
    requireCondition(candidate, `Configured profile ${id} is missing`);
    requireCondition(desired[id], `Desired deployed image ${id} must be supplied from the running service`);
    expect(candidate.image.requestedImage).toMatch(/^913524902871\.dkr\.ecr\.us-east-1\.amazonaws\.com\//);
    expect(candidate.image.resolvedImage).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(candidate.image.architectures).toContain('amd64');
    const profile = candidate.approved && candidate.image.requestedImage === desired[id] ? candidate : await researcher.api<typeof candidate>('POST', '/api/image-profiles', {
      id, name: candidate.name, image: desired[id], expectedVersion: candidate.version,
      requirements: candidate.requirements,
    }, [200], 120_000);
    expect(profile.approved).toBe(true);
    expect(profile.image.requestedImage).toBe(desired[id]);
    expect(profile.requirements).toEqual(candidate.requirements);
    evidence.push({ id, version: profile.version, image: profile.image.resolvedImage, architectures: profile.image.architectures });
  }
  await info.attach('approved-deployment-images', { contentType: 'application/json', body: Buffer.from(JSON.stringify(evidence, null, 2)) });
});
