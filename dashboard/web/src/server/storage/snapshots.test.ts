import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../aws/clients', () => ({ s3: () => ({ send }) }));
import { copyVerified, snapshotPrefix, SnapshotPendingError, streamedSHA256 } from './snapshots';
import type { ArtifactInventory } from '../workflow-adapters/artifact-inventory';
const input = { sourceBucket: 'source', sourcePrefix: 'data/', targetBucket: 'archive', targetPrefix: 'projects/a/v1/', identity: 'dataset:a:1' };
beforeEach(() => {
  send.mockReset().mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    if (command.constructor.name === 'GetObjectCommand') throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: 'data/frame.bin', Size: 3 }] };
    if (command.constructor.name === 'HeadObjectCommand') return command.input.Bucket === 'source'
      ? { VersionId: 'source-version', ETag: '"source-etag"', ContentLength: 3 }
      : { VersionId: 'archive-version', ContentLength: 3, ChecksumSHA256: 'ZmFrZS1jaGVja3N1bQ==', ChecksumType: 'FULL_OBJECT' };
    if (command.constructor.name === 'CopyObjectCommand') return { VersionId: 'archive-version' };
    if (command.constructor.name === 'PutObjectCommand') return { VersionId: 'manifest-version' };
    return {};
  });
});

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const checksum = (text: string) => createHash('sha256').update(text).digest('base64');
const inventory: ArtifactInventory = {
  schemaVersion: 1, kind: 'directory', identity: input.identity, hash: digest('trusted inventory'),
  files: [{ path: 'frame.bin', bytes: 3, sha256: digest('abc') }, { path: 'final/model.zip', bytes: 4, sha256: digest('PPO!') }],
};
function expectedFake() {
  const files = new Map([['data/frame.bin', 'abc'], ['data/final/model.zip', 'PPO!']]);
  send.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const arg = command.input;
    switch (command.constructor.name) {
      case 'GetObjectCommand': {
        if (arg.Key === 'projects/a/v1/manifest.json') throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        const value = files.get(String(arg.Key));
        if (value === undefined) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: Readable.from([Buffer.from(value)]), ContentLength: Buffer.byteLength(value), VersionId: 'source-version' };
      }
      case 'HeadObjectCommand': {
        const key = String(arg.Key).replace('projects/a/v1/', 'data/');
        const value = files.get(key);
        if (value === undefined) throw Object.assign(new Error('missing'), { name: 'NotFound' });
        return { ContentLength: Buffer.byteLength(value), VersionId: arg.Bucket === 'source' ? 'source-version' : 'archive-version',
          ETag: '"etag"', ChecksumSHA256: checksum(value), ChecksumType: 'FULL_OBJECT' };
      }
      case 'CopyObjectCommand': return { VersionId: 'archive-version' };
      case 'PutObjectCommand': return { VersionId: 'manifest-version' };
      case 'ListObjectsV2Command': throw new Error('Inventory-backed publication must not list');
      default: throw new Error(`Unexpected command ${command.constructor.name}`);
    }
  });
  return files;
}

describe('AutoExport inventory-backed snapshots', () => {
  it('supports an unversioned export mirror with ETag preconditions and versioned archive copies', async () => {
    expectedFake(); const original = send.getMockImplementation()!;
    send.mockImplementation(async (command, ...args) => {
      const result = await original(command, ...args);
      if (command.input.Bucket === 'source') {
        delete result.VersionId;
        delete result.ChecksumSHA256;
      }
      return result;
    });
    const result = await snapshotPrefix({ ...input, inventory });
    expect(result.manifest.objects.every(object => object.versionId === 'archive-version')).toBe(true);
    const copies = send.mock.calls.map(([command]) => command).filter(command => command.constructor.name === 'CopyObjectCommand');
    expect(copies.every(command => !command.input.CopySource.includes('?') && command.input.CopySourceIfMatch === '"etag"')).toBe(true);
  });
  it('copies a declared single file without including its siblings', async () => {
    expectedFake();
    const result = await snapshotPrefix({ ...input, sourcePrefix: 'data/frame.bin',
      inventory: { ...inventory, kind: 'file', files: inventory.files.slice(0, 1) } });
    expect(result.manifest.objects.map(object => object.path)).toEqual(['frame.bin']);
    expect(result.manifest.source.prefix).toBe('data/frame.bin');
  });
  it('copies only expected pinned files, after every expected hash matches; never lists S3', async () => {
    const files = expectedFake(); files.set('data/unrelated.bin', 'excluded');
    const result = await snapshotPrefix({ ...input, inventory });
    expect(result.manifest.inventoryHash).toBe(inventory.hash);
    expect(result.manifest.objects.map(object => object.path)).toEqual(['final/model.zip', 'frame.bin']);
    const copies = send.mock.calls.map(([command]) => command).filter(command => command.constructor.name === 'CopyObjectCommand');
    expect(copies).toHaveLength(2);
    expect(copies.every(command => command.input.ChecksumAlgorithm === 'SHA256' && command.input.CopySource.includes('versionId=source-version'))).toBe(true);
    const commands = send.mock.calls.map(([command]) => command);
    const firstCopy = commands.findIndex(command => command.constructor.name === 'CopyObjectCommand');
    expect(commands.slice(0, firstCopy).filter(command => command.constructor.name === 'HeadObjectCommand' && command.input.Bucket === 'source')).toHaveLength(2);
    expect(commands.some(command => command.constructor.name === 'ListObjectsV2Command')).toBe(false);
  });
  it.each(['missing', 'wrong-size', 'same-size-stale'])('keeps %s export pending with no copies or manifest', async kind => {
    const files = expectedFake();
    if (kind === 'missing') files.delete('data/final/model.zip');
    if (kind === 'wrong-size') files.set('data/final/model.zip', 'old');
    if (kind === 'same-size-stale') files.set('data/final/model.zip', 'OLD!');
    await expect(snapshotPrefix({ ...input, inventory })).rejects.toBeInstanceOf(SnapshotPendingError);
    expect(send.mock.calls.some(([command]) => ['CopyObjectCommand', 'PutObjectCommand'].includes(command.constructor.name))).toBe(false);
  });
  it('streams source bytes when AutoExport supplies no SHA256 checksum', async () => {
    expectedFake(); const original = send.getMockImplementation()!;
    send.mockImplementation(async (command, ...args) => {
      const result = await original(command, ...args);
      if (command.constructor.name === 'HeadObjectCommand' && command.input.Bucket === 'source') {
        delete result.ChecksumSHA256; delete result.ChecksumType;
      }
      return result;
    });
    await snapshotPrefix({ ...input, inventory });
    const gets = send.mock.calls.map(([command]) => command).filter(command => command.constructor.name === 'GetObjectCommand' && command.input.Bucket === 'source');
    expect(gets).toHaveLength(2);
    expect(gets.every(command => command.input.VersionId === 'source-version' && command.input.IfMatch === '"etag"')).toBe(true);
  });
  it('rejects a destination copy whose full SHA256 differs despite identical byte count', async () => {
    expectedFake(); const original = send.getMockImplementation()!;
    send.mockImplementation(async (command, ...args) => {
      const result = await original(command, ...args);
      if (command.constructor.name === 'HeadObjectCommand' && command.input.Bucket === 'archive') result.ChecksumSHA256 = checksum('bad');
      return result;
    });
    await expect(snapshotPrefix({ ...input, inventory })).rejects.toBeInstanceOf(SnapshotPendingError);
    expect(send.mock.calls.some(([command]) => command.constructor.name === 'PutObjectCommand')).toBe(false);
  });
  it('does not adopt an old partial manifest solely because its publication identity matches', async () => {
    expectedFake(); const original = send.getMockImplementation()!;
    send.mockImplementation(async (command, ...args) => command.constructor.name === 'GetObjectCommand'
      ? { Body: { transformToString: async () => JSON.stringify({ schemaVersion: 1, identity: input.identity, objects: [{ path: 'frame.bin' }] }) } }
      : original(command, ...args));
    await expect(snapshotPrefix({ ...input, inventory })).rejects.toThrow(/trusted inventory/);
  });
  it('rechecks cancellation after copy and before committing a manifest', async () => {
    expectedFake(); let copied = false; const original = send.getMockImplementation()!;
    send.mockImplementation(async (command, ...args) => {
      if (command.constructor.name === 'CopyObjectCommand') copied = true;
      return original(command, ...args);
    });
    await expect(snapshotPrefix({ ...input, inventory, assertCurrent: async () => {
      if (copied) throw new Error('cancel fence');
    } })).rejects.toThrow('cancel fence');
    expect(send.mock.calls.some(([command]) => command.constructor.name === 'PutObjectCommand')).toBe(false);
  });
  it('honors an already-aborted attempt without storage IO', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(snapshotPrefix({ ...input, inventory, signal: controller.signal })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('multipart full-file verification', () => {
  const source = { bucket: 'source', key: 'model.zip', path: 'model.zip', expected: { path: 'model.zip', bytes: 6, sha256: digest('abcdef') } };
  function multipartFake(value = 'abcdef') {
    const composite = checksum('composite') + '-1';
    send.mockImplementation(async (command) => {
      switch (command.constructor.name) {
        case 'HeadObjectCommand': return command.input.Bucket === 'source'
          ? { ContentLength: 6, ETag: '"source-etag"', VersionId: 'source-version' }
          : { ContentLength: 6, VersionId: 'archive-version', ChecksumSHA256: composite, ChecksumType: 'COMPOSITE' };
        case 'CreateMultipartUploadCommand': return { UploadId: 'multipart' };
        case 'UploadPartCopyCommand': return { CopyPartResult: { ETag: '"part"', ChecksumSHA256: checksum('abcdef') } };
        case 'CompleteMultipartUploadCommand': return { VersionId: 'archive-version' };
        case 'GetObjectCommand': return { ContentLength: 6, VersionId: 'archive-version', Body: Readable.from([Buffer.from(value.slice(0, 3)), Buffer.from(value.slice(3))]) };
        case 'AbortMultipartUploadCommand': return {};
        default: throw new Error(command.constructor.name);
      }
    });
    return composite;
  }
  it('preserves COMPOSITE and records a separately streamed full SHA256', async () => {
    const composite = multipartFake();
    const result = await copyVerified(source, { bucket: 'archive', key: 'model.zip' }, undefined, 3);
    expect(result).toMatchObject({ checksumType: 'COMPOSITE', checksumSHA256: composite, fullSHA256: digest('abcdef') });
    const commands = send.mock.calls.map(([command]) => command);
    expect(commands.find(command => command.constructor.name === 'GetObjectCommand')?.input.VersionId).toBe('archive-version');
    expect(commands.find(command => command.constructor.name === 'UploadPartCopyCommand')?.input).toMatchObject({
      CopySourceRange: 'bytes=0-5', CopySourceIfMatch: '"source-etag"',
    });
  });
  it('rejects matching-length multipart content with the wrong full digest', async () => {
    multipartFake('BADBAD');
    await expect(copyVerified(source, { bucket: 'archive', key: 'model.zip' }, undefined, 3)).rejects.toBeInstanceOf(SnapshotPendingError);
  });
  it('aborts unfinished multipart uploads when part copying fails', async () => {
    multipartFake(); const original = send.getMockImplementation()!;
    send.mockImplementation(async (command, ...args) => {
      if (command.constructor.name === 'UploadPartCopyCommand') throw new Error('copy interrupted');
      return original(command, ...args);
    });
    await expect(copyVerified(source, { bucket: 'archive', key: 'model.zip' }, undefined, 3)).rejects.toThrow('copy interrupted');
    expect(send.mock.calls.some(([command]) => command.constructor.name === 'AbortMultipartUploadCommand')).toBe(true);
  });
  it('rejects truncated and oversized full-file streams', async () => {
    multipartFake('abc');
    await expect(streamedSHA256({ bucket: 'archive', key: 'model.zip', versionId: 'archive-version', bytes: 6 })).rejects.toThrow(/truncated/);
    multipartFake('abcdefghi');
    await expect(streamedSHA256({ bucket: 'archive', key: 'model.zip', versionId: 'archive-version', bytes: 6 })).rejects.toThrow(/exceeded/);
  });
});
describe('immutable S3 snapshots', () => {
  it('pins source and destination versions and commits the manifest after verification', async () => {
    const result = await snapshotPrefix(input);
    const copy = send.mock.calls.map(([command]) => command).find((command) => command.constructor.name === 'CopyObjectCommand');
    expect(copy.input.CopySource).toContain('versionId=source-version');
    expect(copy.input.CopySourceIfMatch).toBe('"source-etag"');
    expect(result.manifest.objects[0]).toMatchObject({ versionId: 'archive-version', checksumType: 'FULL_OBJECT', bytes: 3 });
    const commit = send.mock.calls.at(-1)![0];
    expect(commit.constructor.name).toBe('PutObjectCommand');
    expect(commit.input.IfNoneMatch).toBe('*');
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('does not commit a manifest when destination verification fails', async () => {
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (command, ...args) => command.constructor.name === 'HeadObjectCommand' && command.input.Bucket === 'archive'
      ? { VersionId: 'v', ContentLength: 999 }
      : original(command, ...args));
    await expect(snapshotPrefix(input)).rejects.toThrow(/verification/);
    expect(send.mock.calls.some(([command]) => command.constructor.name === 'PutObjectCommand')).toBe(false);
  });
  it('does not turn a metadata marker into a successful dataset', async () => {
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (command, ...args) => command.constructor.name === 'ListObjectsV2Command'
      ? { Contents: [{ Key: 'data/.dataset.json', Size: 100 }] }
      : original(command, ...args));
    await expect(snapshotPrefix(input)).rejects.toThrow(/No data/);
  });
});

describe('selected runtime-compatible dataset versions',()=>{
  it('copies only explicitly included relative paths and applies excludes before publication',async()=>{
    const base=send.getMockImplementation()!;
    send.mockImplementation(async command=>command.constructor.name==='ListObjectsV2Command'?{Contents:['train/a.bin','train/private/secret.bin','test/a.bin','train2/a.bin','labels.json'].map(path=>({Key:'data/'+path}))}:base(command));
    const result=await snapshotPrefix({...input,selection:{include:['train/','labels.json'],exclude:['train/private/']}});
    expect(result.manifest.objects.map(o=>o.path)).toEqual(['labels.json','train/a.bin']);
    expect(result.manifest.selection).toEqual({include:['labels.json','train/'],exclude:['train/private/']});
    const copies=send.mock.calls.map(([c])=>c).filter(c=>c.constructor.name==='CopyObjectCommand');
    expect(copies).toHaveLength(2);
  });
  it('rejects an oversized selected inventory before any copies or READY manifest',async()=>{
    const base=send.getMockImplementation()!;
    send.mockImplementation(async command=>command.constructor.name==='ListObjectsV2Command'?{Contents:Array.from({length:1025},(_,i)=>({Key:`data/${i}.bin`}))}:base(command));
    await expect(snapshotPrefix(input)).rejects.toThrow(/1024/);
    expect(send.mock.calls.some(([c])=>['CopyObjectCommand','PutObjectCommand'].includes(c.constructor.name))).toBe(false);
  });
  it('does not reuse a manifest for a different include/exclude selection',async()=>{
    send.mockImplementation(async command=>command.constructor.name==='GetObjectCommand'?{Body:{transformToString:async()=>JSON.stringify({schemaVersion:1,identity:input.identity,objects:[{path:'a'}],selection:{include:['old/'],exclude:[]}})}}:{});
    await expect(snapshotPrefix({...input,selection:{include:['new/']}})).rejects.toThrow(/selection mismatch/);
  });
});
it('does not adopt an upload snapshot whose pinned object version is gone or changed',async()=>{
  const first=await snapshotPrefix(input),original=send.getMockImplementation()!;
  send.mockImplementation(async command=>command.constructor.name==='GetObjectCommand'?{Body:{transformToString:async()=>JSON.stringify(first.manifest)}}:
    command.constructor.name==='HeadObjectCommand'?{VersionId:'different',ContentLength:3,ChecksumSHA256:'changed'}:original(command));
  await expect(snapshotPrefix(input)).rejects.toThrow(/version verification/);
});
