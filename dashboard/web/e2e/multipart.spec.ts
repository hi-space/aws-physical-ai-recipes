import { createHash } from 'node:crypto';
import { test, expect } from './researcher-helpers/fixture';
import type { Dataset, Version } from './researcher-helpers/contracts';
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

test('browser multipart upload resumes with checksums and publishes exact READY bytes', async ({ researcher }, info) => {
  test.setTimeout(12 * 60_000);
  const name = `multipart-${researcher.tag}`, filename = 'frames.bin', total = 16 * 1024 ** 2 + 17;
  await researcher.api<Dataset>('POST', '/api/datasets', { name, format: 'binary', tags: ['e2e'] });
  researcher.datasets.push({ name });
  const version = await researcher.api<Version>('POST', `/api/datasets/${name}/versions`, {});
  const base = `/api/datasets/${name}/versions/${version.version}/uploads`;
  const upload = await researcher.api<{ id: string; partSize: number; partCount: number; state: string }>('POST', base, { filename, size: total, lastModified: 1, contentType: 'application/octet-stream' });
  let complete = false;
  const hashes: string[] = [], full = createHash('sha256');
  try {
    expect(upload.partCount).toBe(3);
    for (let part = 1; part <= upload.partCount; part++) {
      const size = Math.min(upload.partSize, total - (part - 1) * upload.partSize), fill = 64 + part;
      const bytes = Buffer.alloc(size, fill), checksumSHA256 = createHash('sha256').update(bytes).digest('base64');
      hashes.push(checksumSHA256); full.update(bytes);
      const signed = await researcher.api<{ url: string; headers: Record<string, string> }>('POST', `${base}/${upload.id}`, { action: 'part', partNumber: part, checksumSHA256 });
      const result = await researcher.page.evaluate(async ({ signed, size, fill }) => {
        try {
          const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: new Uint8Array(size).fill(fill) });
          return { status: response.status, etag: response.headers.get('etag') };
        } catch { throw new Error('Browser multipart transfer failed (signed URL omitted)'); }
      }, { signed, size, fill });
      expect(result.status).toBe(200); expect(result.etag).toBeTruthy();
      if (part === 1) {
        await researcher.api('POST', `/api/datasets/${name}/versions/${version.version}`, { action: 'refresh-size' }, [409]);
        const resumed = await researcher.api<{ parts: Array<{ number: number; checksum: string; size: number }> }>('GET', `${base}/${upload.id}`);
        expect(resumed.parts).toHaveLength(1);
        expect(resumed.parts[0]).toMatchObject({ number: 1, checksum: checksumSHA256, size });
      }
    }
    const result = await researcher.api<{ state: string }>('POST', `${base}/${upload.id}`, { action: 'complete', checksums: hashes });
    expect(result.state).toBe('COMPLETED'); complete = true;
    await researcher.api('POST', `/api/datasets/${name}/versions/${version.version}`, { action: 'refresh-size' });
    const ready = await researcher.readyVersion(name, version.version);
    expect(ready.objectCount).toBe(1); expect(ready.sizeBytes).toBe(total);
    const expected = full.digest('hex'), downloaded = await researcher.versionFile(ready, filename);
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(expected);
    await info.attach('multipart-proof', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ dataset: name, version: version.version, bytes: total, parts: upload.partCount, sha256: expected, manifestHash: ready.manifestHash, corsVerified: true, resumeVerified: true })) });
  } finally {
    if (!complete) await researcher.api('DELETE', `${base}/${upload.id}`);
  }
});
