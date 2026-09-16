import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { badRequest } from '../errors';
import { safeRelativePath } from './report';

export const DIRECTORY_DIGEST = 'pai-directory-sha256-v1' as const;
export interface BundleFile { path: string; bytes: number; sha256: string }
export interface CheckpointDirectory {
  schemaVersion: 1; algorithm: typeof DIRECTORY_DIGEST; digest: string; files: BundleFile[];
}
export type CheckpointDirectorySummary = Omit<CheckpointDirectory, 'files'> & { fileCount: number };
const limits = { files: 10_000, expandedBytes: 100 * 1024 ** 3, metadataBytes: 1024 * 1024 };

/** Length-framed UTF-8 names, byte counts and full file digests. This is NOT the
 * SHA256 of a tarball, an S3 multipart checksum, or a hash of concatenated bytes. */
export function directoryManifest(files: BundleFile[]): CheckpointDirectory {
  if (!files.length || files.length > limits.files) throw badRequest('Checkpoint bundle file count is invalid');
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const seen = new Set<string>(), hash = createHash('sha256');
  for (const file of sorted) {
    safeRelativePath(file.path);
    if (seen.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw badRequest('Invalid checkpoint bundle entry');
    seen.add(file.path);
    hash.update(`${Buffer.byteLength(file.path)}:${file.path}\0${file.bytes}\0${file.sha256}\n`);
  }
  return { schemaVersion: 1, algorithm: DIRECTORY_DIGEST, digest: hash.digest('hex'), files: sorted };
}

class Reader {
  private iterator: AsyncIterator<Uint8Array>;
  private buffer = Buffer.alloc(0);
  constructor(source: AsyncIterable<Uint8Array>, private signal?: AbortSignal) { this.iterator = source[Symbol.asyncIterator](); }
  async *take(bytes: number): AsyncGenerator<Buffer> {
    while (bytes > 0) {
      this.signal?.throwIfAborted();
      if (!this.buffer.length) {
        const next = await this.iterator.next();
        if (next.done) throw badRequest('Truncated checkpoint tar archive');
        this.buffer = Buffer.from(next.value);
      }
      const length = Math.min(bytes, this.buffer.length);
      yield this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length); bytes -= length;
    }
  }
  async read(bytes: number) {
    if (bytes > limits.metadataBytes) throw badRequest('Checkpoint tar metadata exceeds limit');
    const chunks: Buffer[] = [];
    for await (const chunk of this.take(bytes)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  async trailingZeros() {
    if (this.buffer.some(byte => byte !== 0)) throw badRequest('Unexpected trailing tar data');
    this.buffer = Buffer.alloc(0);
    let padding = 0;
    while (true) {
      this.signal?.throwIfAborted();
      const next = await this.iterator.next();
      if (next.done) return;
      padding += next.value.byteLength;
      if (padding > limits.metadataBytes || next.value.some(byte => byte !== 0)) throw badRequest('Unexpected trailing tar data');
    }
  }
}
const text = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0.*$/s, '');
function octal(bytes: Buffer) {
  if (bytes[0] & 0x80) {
    if (bytes[0] & 0x40) throw badRequest('Negative tar numeric encoding');
    let value = BigInt(bytes[0] & 0x7f);
    for (const byte of bytes.subarray(1)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw badRequest('Tar size exceeds safe integer range');
    return Number(value);
  }
  const value = text(bytes).trim();
  if (value && !/^[0-7]+$/.test(value)) throw badRequest('Unsupported tar numeric encoding');
  const number = value ? parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(number) || number < 0) throw badRequest('Invalid tar size');
  return number;
}
function pax(bytes: Buffer) {
  const result: Record<string, string> = Object.create(null);
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw badRequest('Invalid PAX header');
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d*$/.test(lengthText)) throw badRequest('Invalid PAX length');
    const end = offset + Number(lengthText);
    if (!Number.isSafeInteger(end) || end > bytes.length || end <= space + 1 || bytes[end - 1] !== 10) throw badRequest('Invalid PAX length');
    const record = text(bytes.subarray(space + 1, end - 1)), separator = record.indexOf('=');
    if (separator < 1) throw badRequest('Invalid PAX record');
    const key = record.slice(0, separator);
    if (key.startsWith('GNU.sparse') || key === 'linkpath') throw badRequest('Sparse/link tar entries are unsupported');
    result[key] = record.slice(separator + 1); offset = end;
  }
  return result;
}
function entryPath(value: string, directory = false) {
  let path = value;
  while (path.startsWith('./')) path = path.slice(2);
  if (directory) path = path.replace(/\/$/, '');
  if (directory && (!path || path === '.')) return '';
  safeRelativePath(path);
  if (path.length > 2048) throw badRequest('Tar path is too long');
  return path;
}

/** Inspect the actual gzip/tar stream without extraction or buffering model
 * weights. Reject traversal, links, devices, sparse/duplicate entries and bombs.
 * Supports POSIX/PAX and GNU long-name headers used by SageMaker model.tar.gz. */
export async function inspectCheckpointTar(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<CheckpointDirectory> {
  const input = Readable.from(source), gzip = createGunzip();
  input.on('error', error => gzip.destroy(error));
  input.pipe(gzip);
  const reader = new Reader(gzip, signal), files: BundleFile[] = [], paths = new Set<string>();
  let total = 0, entries = 0, extension: Record<string, string> = Object.create(null);
  let global: Record<string, string> = Object.create(null);
  try {
    while (true) {
      const header = await reader.read(512);
      if (header.every(byte => byte === 0)) {
        if (!(await reader.read(512)).every(byte => byte === 0)) throw badRequest('Invalid tar terminator');
        if (Object.keys(extension).length) throw badRequest('Orphaned tar metadata');
        await reader.trailingZeros(); // Also consumes gzip trailer and verifies CRC.
        break;
      }
      if (++entries > limits.files * 3) throw badRequest('Too many checkpoint tar entries');
      const sum = header.reduce((n, byte, index) => n + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (octal(header.subarray(148, 156)) !== sum) throw badRequest('Tar header checksum mismatch');
      let size = octal(header.subarray(124, 136));
      const type = header[156] ? String.fromCharCode(header[156]) : '0';
      if (['x', 'g', 'L'].includes(type)) {
        const metadata = await reader.read(size);
        if (type === 'L') extension.path = text(metadata).replace(/\n$/, '');
        else if (type === 'g') {
          const values = pax(metadata);
          if ('path' in values || 'size' in values) throw badRequest('Global PAX path/size overrides are unsupported');
          global = { ...global, ...values };
        } else extension = { ...extension, ...pax(metadata) };
        await reader.read((512 - size % 512) % 512);
        continue;
      }
      if (!['0', '5'].includes(type)) throw badRequest('Only regular files/directories are allowed in a model bundle');
      const values = { ...global, ...extension }; extension = Object.create(null);
      if (values.size !== undefined) {
        if (!/^\d+$/.test(values.size)) throw badRequest('Invalid PAX size');
        size = Number(values.size);
      }
      if (!Number.isSafeInteger(size) || size < 0 || total + size > limits.expandedBytes) throw badRequest('Expanded checkpoint bundle exceeds 100 GiB');
      const prefix = header.subarray(257, 263).equals(Buffer.from('ustar\0')) ? text(header.subarray(345, 500)) : '';
      const name = text(header.subarray(0, 100));
      const path = entryPath(values.path ?? (prefix ? `${prefix}/${name}` : name), type === '5');
      if (path && paths.has(path)) throw badRequest('Duplicate tar path');
      if (path) paths.add(path);
      if (type === '5') {
        if (size !== 0) throw badRequest('Directory tar entry has a body');
        continue;
      }
      if (files.length >= limits.files) throw badRequest('Checkpoint bundle exceeds 10000 files');
      for (const prior of files) if (path.startsWith(prior.path + '/') || prior.path.startsWith(path + '/')) throw badRequest('Tar file/directory collision');
      const hash = createHash('sha256');
      for await (const chunk of reader.take(size)) hash.update(chunk);
      files.push({ path, bytes: size, sha256: hash.digest('hex') }); total += size;
      await reader.read((512 - size % 512) % 512);
    }
    return directoryManifest(files);
  } finally { input.destroy(); gzip.destroy(); }
}
