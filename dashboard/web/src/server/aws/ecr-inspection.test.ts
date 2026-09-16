import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { inspectEcrImage, parsePrivateEcrImage, type EcrInspectionDeps } from './ecr-inspection';

const scope = { accountId: '123456789012', region: 'us-east-1' };
const registry = '123456789012.dkr.ecr.us-east-1.amazonaws.com';
const uri = `${registry}/recipes/train:stable`;
const auth = Buffer.from('AWS:private-review-token').toString('base64');
const encoded = (value: unknown) => JSON.stringify(value);
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fixture(architecture = 'amd64') {
  const config = encoded({ architecture, os: 'linux', config: { Env: ['SHOULD_NOT_BE_RETURNED=private'] } });
  const manifest = encoded({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: digest(config), size: config.length }, layers: [] });
  const blobs = new Map([[digest(config), config], [digest(manifest), manifest]]);
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(new URL(url).origin).toBe(`https://${registry}`);
    expect(init?.redirect).toBe('manual');
    const value = blobs.get(url.split('/').at(-1)!);
    if (!value) return new Response('not found', { status: 404 });
    return new Response(value);
  });
  const deps: EcrInspectionDeps = {
    resolveDigest: vi.fn(async () => digest(manifest)),
    authorize: vi.fn(async () => ({ token: auth, endpoint: `https://${registry}` })),
    fetch: fetcher as typeof fetch,
    now: () => new Date('2026-09-16T12:00:00Z'),
  };
  return { deps, blobs, config, manifest, fetcher };
}

describe('private ECR inspection', () => {
  it('pins the resolved digest and verifies config architecture without returning config or credentials', async () => {
    const f = fixture();
    const result = await inspectEcrImage(uri, scope, f.deps);
    expect(result.resolvedImage).toBe(`${registry}/recipes/train@${digest(f.manifest)}`);
    expect(result.architectures).toEqual(['amd64']);
    expect(result.manifests[0].configDigest).toBe(digest(f.config));
    expect(result.inspectedAt).toBe('2026-09-16T12:00:00.000Z');
    expect(f.fetcher.mock.calls[0][0]).toContain(`/manifests/${digest(f.manifest)}`);
    expect(JSON.stringify(result)).not.toMatch(/private-review-token|SHOULD_NOT_BE_RETURNED/);
    expect(JSON.stringify(result)).not.toContain(auth);
  });

  it.each([
    'https://user:password@evil.example/image:tag', 'public.ecr.aws/docker/library/python:3',
    '999999999999.dkr.ecr.us-east-1.amazonaws.com/repo:tag',
    '123456789012.dkr.ecr.eu-west-1.amazonaws.com/repo:tag',
    `${registry}/repo`, `${registry}/../repo:tag`, `${registry}:443/repo:tag`,
  ])('rejects unapproved registry syntax before any probe: %s', async (input) => {
    const f = fixture();
    await expect(inspectEcrImage(input, scope, f.deps)).rejects.toMatchObject({ code: 'image_mirror_required' });
    expect(f.deps.authorize).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('checks every supported index child against its actual config, skipping attestation descriptors', async () => {
    const f = fixture();
    const arm = fixture('arm64');
    for (const [key, value] of arm.blobs) f.blobs.set(key, value);
    const index = encoded({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
      { digest: digest(f.manifest), platform: { os: 'linux', architecture: 'amd64' } },
      { digest: digest(arm.manifest), platform: { os: 'linux', architecture: 'arm64' } },
      { digest: 'sha256:' + '0'.repeat(64), platform: { os: 'unknown', architecture: 'unknown' } },
    ] });
    f.blobs.set(digest(index), index);
    f.deps.resolveDigest = async () => digest(index);
    expect((await inspectEcrImage(uri, scope, f.deps)).architectures).toEqual(['amd64', 'arm64']);
  });

  it('rejects forged manifest bytes and config/platform disagreement', async () => {
    const f = fixture();
    f.blobs.set(digest(f.manifest), f.manifest + ' ');
    await expect(inspectEcrImage(uri, scope, f.deps)).rejects.toMatchObject({ code: 'image_inspection_failed' });
    const arm = fixture('arm64');
    const index = encoded({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
      { digest: digest(arm.manifest), platform: { os: 'linux', architecture: 'amd64' } },
    ] });
    arm.blobs.set(digest(index), index); arm.deps.resolveDigest = async () => digest(index);
    await expect(inspectEcrImage(uri, scope, arm.deps)).rejects.toMatchObject({ code: 'image_inspection_failed' });
  });

  it('never follows arbitrary config redirects or returns upstream error text', async () => {
    const f = fixture();
    f.deps.fetch = vi.fn(async (input) => String(input).includes('/manifests/')
      ? new Response(f.manifest)
      : new Response(null, { status: 307, headers: { location: 'https://evil.example/credentials' } })) as typeof fetch;
    await expect(inspectEcrImage(uri, scope, f.deps)).rejects.toMatchObject({ code: 'image_inspection_failed' });
    expect(vi.mocked(f.deps.fetch).mock.calls).toHaveLength(2);
    f.deps.authorize = async () => { throw new Error(`upstream secret ${auth}`); };
    await expect(inspectEcrImage(uri, scope, f.deps)).rejects.not.toThrow(auth);
  });

  it('removes authorization on an ECR-owned S3 blob redirect and verifies the downloaded digest', async () => {
    const f = fixture();
    const target = 'https://prod-us-east-1-starport-layer-bucket.s3.us-east-1.amazonaws.com/blob?signature=fixture';
    f.deps.fetch = vi.fn(async (input, init) => {
      if (String(input).includes('/manifests/')) return new Response(f.manifest);
      if (String(input) === target) {
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        return new Response(f.config);
      }
      return new Response(null, { status: 307, headers: { location: target } });
    }) as typeof fetch;
    expect((await inspectEcrImage(uri, scope, f.deps)).architectures).toEqual(['amd64']);
  });

  it('requires the fixed supported region and explicit current account', () => {
    expect(() => parsePrivateEcrImage(uri, { accountId: '', region: 'us-east-1' })).toThrow();
    expect(() => parsePrivateEcrImage(uri, { ...scope, region: 'us-west-2' })).toThrow();
  });
});
