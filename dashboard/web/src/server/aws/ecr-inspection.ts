import { createHash } from 'node:crypto';
import { DescribeImagesCommand, ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { HttpError } from '../errors';

export interface ImageScope { accountId: string; region: string }
export type ImageArchitecture = 'amd64' | 'arm64';
export interface EcrImageReference extends ImageScope { registry: string; repository: string; tag?: string; digest?: string }
export interface ImageInspection extends ImageScope {
  requestedImage: string; resolvedImage: string; digest: string; repository: string;
  architectures: ImageArchitecture[];
  manifests: { digest: string; configDigest: string; architecture: ImageArchitecture; os: 'linux' }[];
  inspectedAt: string; source: 'ecr-manifest-config';
}
export interface EcrInspectionDeps {
  resolveDigest(ref: EcrImageReference): Promise<string>;
  authorize(ref: EcrImageReference): Promise<{ token: string; endpoint: string }>;
  fetch: typeof fetch;
  now(): Date;
}
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const failure = () => new HttpError(503, 'ECR 이미지 manifest/config를 검증하지 못했습니다. 권한과 이미지 형식을 확인하세요.', 'image_inspection_failed');
export function parsePrivateEcrImage(image: string, scope: ImageScope): EcrImageReference {
  if (!/^\d{12}$/.test(scope.accountId) || scope.region !== 'us-east-1') {
    throw new HttpError(503, '현재 계정과 us-east-1 이미지 검사 구성이 필요합니다.', 'image_configuration');
  }
  const match = /^(\d{12})\.dkr\.ecr\.us-east-1\.amazonaws\.com\/([a-z0-9]+(?:(?:[._/]|__|-+)[a-z0-9]+)*)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})|@(sha256:[a-f0-9]{64}))$/.exec(image);
  if (!match || match[1] !== scope.accountId || match[2].length > 256) {
    throw new HttpError(400, '현재 계정의 us-east-1 private ECR에 미러링하고 명시적인 tag 또는 digest를 사용하세요.', 'image_mirror_required');
  }
  return { ...scope, registry: `${scope.accountId}.dkr.ecr.us-east-1.amazonaws.com`, repository: match[2], tag: match[3], digest: match[4] };
}
function defaults(scope: ImageScope): EcrInspectionDeps {
  const ecr = new ECRClient({ region: scope.region });
  return {
    resolveDigest: async (ref) => {
      if (ref.digest) return ref.digest;
      const out = await ecr.send(new DescribeImagesCommand({ registryId: ref.accountId, repositoryName: ref.repository, imageIds: [{ imageTag: ref.tag }] }), { abortSignal: AbortSignal.timeout(15_000) });
      return out.imageDetails?.[0]?.imageDigest ?? '';
    },
    authorize: async (ref) => {
      const out = await ecr.send(new GetAuthorizationTokenCommand({ registryIds: [ref.accountId] }), { abortSignal: AbortSignal.timeout(15_000) });
      const value = out.authorizationData?.find(item => item.proxyEndpoint === `https://${ref.registry}`);
      return { token: value?.authorizationToken ?? '', endpoint: value?.proxyEndpoint ?? '' };
    },
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  };
}
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > limit) {
    await response.body?.cancel(); throw failure();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw failure();
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  return Buffer.concat(chunks, size);
}
/** Only ECR's documented regional layer bucket can receive a credential-free blob redirect. */
function layerRedirect(location: string): URL {
  const url = new URL(location), bucket = 'prod-us-east-1-starport-layer-bucket';
  const hosts = [`${bucket}.s3.us-east-1.amazonaws.com`, `${bucket}.s3.amazonaws.com`, `${bucket}.s3-us-east-1.amazonaws.com`];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !hosts.includes(url.hostname)) throw failure();
  return url;
}
/** Fetches only one account's private ECR; no layers are pulled or containers executed. */
export async function inspectEcrImage(image: string, scope: ImageScope, deps?: EcrInspectionDeps): Promise<ImageInspection> {
  const ref = parsePrivateEcrImage(image, scope), d = deps ?? defaults(scope);
  try {
    const digest = ref.digest ?? await d.resolveDigest(ref);
    if (!digestPattern.test(digest)) throw failure();
    const authorization = await d.authorize(ref);
    if (authorization.endpoint !== `https://${ref.registry}` || !/^[A-Za-z0-9+/=]+$/.test(authorization.token) ||
        !Buffer.from(authorization.token, 'base64').toString().startsWith('AWS:')) throw failure();
    const read = async (kind: 'manifests' | 'blobs', expected: string) => {
      if (!digestPattern.test(expected)) throw failure();
      const signal = AbortSignal.timeout(15_000);
      let response = await d.fetch(`https://${ref.registry}/v2/${ref.repository}/${kind}/${expected}`, {
        headers: { authorization: `Basic ${authorization.token}`, accept: kind === 'blobs' ? 'application/octet-stream'
          : 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' },
        redirect: 'manual', signal,
      });
      if (kind === 'blobs' && [302, 307].includes(response.status)) {
        const target = layerRedirect(response.headers.get('location') ?? '');
        await response.body?.cancel();
        response = await d.fetch(target, { headers: { accept: 'application/octet-stream' }, redirect: 'manual', signal });
      }
      const bytes = await boundedBytes(response, kind === 'blobs' ? 1024 * 1024 : 4 * 1024 * 1024);
      if (sha(bytes) !== expected) throw failure();
      return JSON.parse(Buffer.from(bytes).toString('utf8'));
    };
    const root = await read('manifests', digest);
    if (root.schemaVersion !== 2) throw failure();
    const isIndex = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'].includes(root.mediaType);
    if (isIndex && (!Array.isArray(root.manifests) || root.manifests.length > 32)) throw failure();
    const targets: { digest: string; platform?: { architecture?: string; os?: string } }[] = isIndex
      ? root.manifests.filter((entry: { platform?: { architecture?: string; os?: string } }) =>
        entry.platform?.os === 'linux' && ['amd64', 'arm64'].includes(entry.platform.architecture ?? ''))
      : [{ digest }];
    if (!targets.length || targets.length > 8) throw failure();
    const manifests: ImageInspection['manifests'] = [];
    for (const target of targets) {
      const manifest = target.digest === digest ? root : await read('manifests', target.digest);
      if (manifest.schemaVersion !== 2 || !['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(manifest.mediaType)) throw failure();
      const configDigest = manifest.config?.digest;
      if (typeof configDigest !== 'string') throw failure();
      const config = await read('blobs', configDigest);
      if (config.os !== 'linux' || !['amd64', 'arm64'].includes(config.architecture) ||
          target.platform && (target.platform.architecture !== config.architecture || target.platform.os !== config.os)) throw failure();
      manifests.push({ digest: target.digest, configDigest, architecture: config.architecture, os: 'linux' });
    }
    return {
      ...scope, requestedImage: image, resolvedImage: `${ref.registry}/${ref.repository}@${digest}`, repository: ref.repository, digest,
      architectures: [...new Set(manifests.map(value => value.architecture))].sort(), manifests,
      inspectedAt: d.now().toISOString(), source: 'ecr-manifest-config',
    };
  } catch { throw failure(); } // Never propagate SDK/fetch bodies, token values, or signed redirect URLs.
}
