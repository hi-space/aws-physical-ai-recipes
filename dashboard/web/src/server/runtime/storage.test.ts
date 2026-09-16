import { expect, it, vi } from 'vitest';
const {
  send
} = vi.hoisted(() => ({
  send: vi.fn()
}));
vi.mock('../aws/clients', () => ({
  s3: () => ({
    send
  })
}));
import { objectStorage } from './storage';
it.each(['COMPOSITE', undefined])('preserves a pinned S3 composite digest and infers a missing type from its suffix (%s)', async ChecksumType => {
  const checksum = Buffer.alloc(32, 1).toString('base64') + '-2';
  send.mockResolvedValue({
    VersionId: 'v1',
    ContentLength: 7,
    ChecksumSHA256: checksum,
    ChecksumType
  });
  expect(await objectStorage.head('bucket', 'key', 'v1')).toEqual({
    versionId: 'v1',
    size: 7,
    checksumSHA256: checksum,
    checksumType: 'COMPOSITE'
  });
  expect(send.mock.calls.at(-1)![0].input).toMatchObject({
    VersionId: 'v1',
    ChecksumMode: 'ENABLED'
  });
});

it('reads the exact committed manifest version and rejects a different returned version', async () => {
  send.mockResolvedValue({ VersionId: 'manifest-v1', ContentLength: 2, Body: { transformToString: async () => '{}' } });
  expect(await objectStorage.readManifest('bucket', 'manifest.json', undefined, 'manifest-v1')).toEqual({ body: '{}', versionId: 'manifest-v1' });
  expect(send.mock.calls.at(-1)![0].input).toMatchObject({ VersionId: 'manifest-v1' });
  send.mockResolvedValue({ VersionId: 'other-version', ContentLength: 2, Body: { transformToString: async () => '{}' } });
  await expect(objectStorage.readManifest('bucket', 'manifest.json', undefined, 'manifest-v1')).rejects.toThrow(/version mismatch/);
});
