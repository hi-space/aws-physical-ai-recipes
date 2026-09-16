import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
const { send, sign } = vi.hoisted(() => ({ send: vi.fn(), sign: vi.fn() }));
vi.mock('../aws/clients', () => ({ s3: () => ({ send }) }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: sign }));
import { multipartStorage } from './multipart-storage';
beforeEach(() => { send.mockReset(); sign.mockReset(); });

it('streams a pinned object through full SHA256 without transformToString/byte-array buffering', async () => {
  const chunks = [Buffer.alloc(65_537, 19), Buffer.from('last partial bytes')];
  const stream = Readable.from(chunks);
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  send.mockResolvedValue({ Body: stream, VersionId: 'v1', ContentLength: size });
  const check = vi.fn(async () => {});
  const digest = await multipartStorage.sha256('bucket', 'key', 'v1', size, new AbortController().signal, check);
  expect(digest).toBe(createHash('sha256').update(Buffer.concat(chunks)).digest('base64'));
  expect(send.mock.calls[0][0].input).toEqual({ Bucket: 'bucket', Key: 'key', VersionId: 'v1' });
  expect(stream.destroyed).toBe(true);
  expect(check.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it.each(['wrong-version', 'wrong-size', 'truncated', 'oversized', 'cancelled'])('rejects %s streams and closes their bodies', async mode => {
  const stream = Readable.from([Buffer.from(mode === 'truncated' ? 'ab' : mode === 'oversized' ? 'abcd' : 'abc')]);
  send.mockResolvedValue({ Body: stream, VersionId: mode === 'wrong-version' ? 'other' : 'v1', ContentLength: mode === 'wrong-size' ? 4 : 3 });
  const controller = new AbortController();
  await expect(multipartStorage.sha256('b', 'k', 'v1', 3, controller.signal, async () => {
    if (mode === 'cancelled') controller.abort();
  })).rejects.toThrow();
  expect(stream.destroyed).toBe(true);
});
it('paginates ListParts and requests only one part for a resume check', async () => {
  const part = (number: number) => ({ PartNumber: number, Size: 5 * 1024 ** 2, ETag: `"part-${number}"`, ChecksumSHA256: Buffer.alloc(32, number).toString('base64') });
  send.mockResolvedValueOnce({ Parts: [part(1)], IsTruncated: true, NextPartNumberMarker: '1' })
    .mockResolvedValueOnce({ Parts: [part(2)] });
  expect((await multipartStorage.parts('b', 'k', 'upload')).map(part => part.number)).toEqual([1, 2]);
  expect(send.mock.calls[1][0].input.PartNumberMarker).toBe('1');
  send.mockReset().mockResolvedValue({ Parts: [part(2)], IsTruncated: true, NextPartNumberMarker: '2' });
  expect(await multipartStorage.parts('b', 'k', 'upload', undefined, 2)).toHaveLength(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].input).toMatchObject({ PartNumberMarker: '1', MaxParts: 1 });
});
it('rejects nonadvancing S3 pagination and missing part checksums', async () => {
  send.mockResolvedValue({ Parts: [], IsTruncated: true, NextPartNumberMarker: '1' });
  await expect(multipartStorage.parts('b', 'k', 'u')).rejects.toThrow(/cursor/);
  expect(send).toHaveBeenCalledTimes(2);
  send.mockReset().mockResolvedValue({ Parts: [{ PartNumber: 1, Size: 1, ETag: 'etag' }] });
  await expect(multipartStorage.parts('b', 'k', 'u')).rejects.toThrow(/verified identity/);
});
it('signs exact part bytes/checksum and completes with a separate composite checksum and create-only condition', async () => {
  const digest = Buffer.alloc(32, 3).toString('base64');
  sign.mockResolvedValue('https://signed.invalid/part');
  const part = { number: 1, size: 5 * 1024 ** 2, checksumSHA256: digest, etag: 's3-etag' };
  const result = await multipartStorage.sign('b', 'k', 'upload', part);
  expect(result.headers).toEqual({ 'x-amz-checksum-sha256': digest });
  expect(sign.mock.calls[0][1].input).toMatchObject({ PartNumber: 1, ContentLength: part.size, ChecksumSHA256: digest });
  send.mockResolvedValue({});
  await multipartStorage.complete('b', 'k', 'upload', [part], digest + '-1');
  expect(send.mock.calls[0][0].input).toMatchObject({
    IfNoneMatch: '*', ChecksumType: 'COMPOSITE', ChecksumSHA256: digest + '-1',
    MultipartUpload: { Parts: [{ PartNumber: 1, ETag: 's3-etag', ChecksumSHA256: digest }] },
  });
});
