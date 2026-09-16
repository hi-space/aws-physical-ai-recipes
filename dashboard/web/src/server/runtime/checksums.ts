import { validChecksum } from './uploads';
export type InputChecksumType = 'FULL_OBJECT' | 'COMPOSITE';
/** A composite checksum identifies the multipart object; it is not a whole-file digest. */
export function inputChecksumType(value: unknown, checksum: unknown): InputChecksumType | undefined {
  if (typeof checksum !== 'string') return undefined;
  const type = value ?? (checksum.includes('-') ? 'COMPOSITE' : 'FULL_OBJECT');
  if (type === 'FULL_OBJECT') return validChecksum(checksum) ? type : undefined;
  if (type !== 'COMPOSITE') return undefined;
  const [digest, parts, ...rest] = checksum.split('-');
  if (!validChecksum(digest) || rest.length || parts !== undefined && (!/^[0-9]+$/.test(parts) || !Number.isSafeInteger(Number(parts)) || Number(parts) <= 0)) return undefined;
  return type;
}
