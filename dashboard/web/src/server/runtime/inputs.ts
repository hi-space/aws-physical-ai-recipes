import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { HttpError } from '../errors';
import type { BrokerDeps } from './broker';
import type { AuthContext } from './ledger';
import { objectStorage } from './storage';
import { safeRelative } from './uploads';
import { inputChecksumType, type InputChecksumType } from './checksums';
export async function inputPlan(deps: BrokerDeps, context: AuthContext) {
  const storage = deps.storage ?? objectStorage,
    inputs: {
      index: number;
      fsxPath: string;
      destination: string;
      manifestHash: string;
      files: {
        path: string;
        size: number;
        checksumSHA256: string;
        checksumType: InputChecksumType;
        versionId: string;
        url: string;
      }[];
    }[] = [];
  const snapshots = context.workflow.datasetSnapshots?.[context.spec.name] ?? {};
  for (const [index, input] of context.spec.inputs.entries()) if ('dataset' in input) {
    const snapshot = snapshots[index];
    if (!snapshot || snapshot.name !== input.dataset.name || snapshot.version !== input.dataset.version) throw new HttpError(409, 'Declared dataset input has no matching immutable snapshot');
  }
  for (const [key, snapshot] of Object.entries(snapshots)) {
    if (!/^\/fsx\//.test(snapshot.fsxPath) || posix.normalize(snapshot.fsxPath) !== snapshot.fsxPath || /[\\%\x00-\x1f]/.test(snapshot.fsxPath)) throw new HttpError(409, 'Input destination path is unsafe');
    if (!snapshot.manifestHash || !snapshot.fsxPath.startsWith(`/fsx/datasets/projects/${context.claims.projectId}/`)) throw new HttpError(409, 'Pinned input manifest or project path is unavailable');
    const version = await deps.repo.getVersion(snapshot.name, snapshot.version);
    if (!version || version.projectId !== context.workflow.projectId || version.uri !== snapshot.uri || version.manifestHash !== snapshot.manifestHash || !version.manifestUri || version.state !== 'READY') throw new HttpError(409, 'Pinned input version is not verified');
    let uri: URL;
    try {
      uri = new URL(version.manifestUri);
    } catch {
      throw new HttpError(409, 'Input manifest URI is invalid');
    }
    if (uri.protocol !== 's3:' || uri.hostname !== deps.artifactBucket || uri.search || uri.hash || uri.username || !uri.pathname.startsWith(`/projects/${context.claims.projectId}/`)) throw new HttpError(403, 'Input manifest is outside authorized project storage');
    const manifestKey = uri.pathname.slice(1),
      prefix = manifestKey.slice(0, manifestKey.lastIndexOf('/') + 1);
    const stored = await storage.readManifest(uri.hostname, manifestKey);
    if (!stored || createHash('sha256').update(stored.body).digest('hex') !== snapshot.manifestHash) throw new HttpError(409, 'Input manifest checksum does not match snapshot');
    let manifest: {
      projectId?: string;
      schemaVersion?: number;
      identity?: string;
      source?: {
        bucket?: string;
        prefix?: string;
      };
      objects?: {
        key: string;
        path?: string;
        versionId: string;
        bytes?: number;
        size?: number;
        checksumSHA256: string;
        checksumType?: string;
      }[];
    };
    try {
      manifest = JSON.parse(stored.body);
    } catch {
      throw new HttpError(409, 'Input manifest is malformed');
    }
    const schema1 = manifest.schemaVersion === 1;
    const identityValid = schema1 ? typeof manifest.identity === 'string' && !!manifest.identity && typeof manifest.source?.bucket === 'string' && typeof manifest.source.prefix === 'string' : manifest.schemaVersion === undefined && manifest.projectId === context.claims.projectId;
    if (!identityValid || !Array.isArray(manifest.objects) || !manifest.objects.length || manifest.objects.length > 1024) throw new HttpError(409, 'Input manifest has no verified object set');
    const files: typeof inputs[number]['files'] = [],
      seen = new Set<string>();
    for (const object of manifest.objects) {
      const relative = typeof object.key === 'string' && object.key.startsWith(prefix) ? object.key.slice(prefix.length) : '';
      const path = schema1 ? object.path ?? '' : relative;
      const checksumType = inputChecksumType(object.checksumType, object.checksumSHA256);
      const size = object.bytes ?? object.size;
      if (!safeRelative(path) || path !== relative || path.split('/').some(segment => segment.startsWith('.pai-input-')) || seen.has(path) || !object.versionId || object.versionId === 'null' || !Number.isSafeInteger(size) || (size ?? -1) < 0 || !checksumType) throw new HttpError(409, 'Input manifest contains an invalid object');
      seen.add(path);
      const head = await storage.head(uri.hostname, object.key, object.versionId);
      if (inputChecksumType(head.checksumType, head.checksumSHA256) !== checksumType || head.versionId !== object.versionId || head.size !== size || head.checksumSHA256 !== object.checksumSHA256) throw new HttpError(409, 'Pinned input object verification failed');
      files.push({
        path,
        size: size!,
        checksumSHA256: object.checksumSHA256,
        checksumType,
        versionId: object.versionId,
        url: await storage.presignGet(uri.hostname, object.key, object.versionId, 300)
      });
    }
    inputs.push({
      index: Number(key),
      fsxPath: snapshot.fsxPath,
      destination: snapshot.fsxPath,
      manifestHash: snapshot.manifestHash,
      files
    });
  }
  return {
    inputs
  };
}
