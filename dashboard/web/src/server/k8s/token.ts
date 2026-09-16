/**
 * EKS bearer tokens are presigned STS GetCallerIdentity URLs with the
 * `x-k8s-aws-id: <cluster>` header signed in, base64url-encoded with the
 * `k8s-aws-v1.` prefix. Valid for 15 minutes; we cache for 14.
 */
import { presignUrl } from '../aws/sigv4';

const cache = new Map<string, { token: string; expiresAt: number }>();

export function encodeEksToken(presignedUrl: string): string {
  return 'k8s-aws-v1.' + Buffer.from(presignedUrl, 'utf8').toString('base64url').replace(/=+$/, '');
}

export async function mintEksToken(clusterName: string, region: string): Promise<{ token: string; expiresAt: number }> {
  const k = `${region}/${clusterName}`;
  const hit = cache.get(k);
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit;
  const url = await presignUrl({
    service: 'sts',
    region,
    url: `https://sts.${region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15`,
    method: 'GET',
    headers: { 'x-k8s-aws-id': clusterName },
    expiresIn: 60,
  });
  const entry = { token: encodeEksToken(url), expiresAt: Date.now() + 14 * 60_000 };
  cache.set(k, entry);
  return entry;
}
