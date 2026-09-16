import { expect, it, vi } from 'vitest';
import { mintEksToken } from '../k8s/token';
import { presignUrl } from '../aws/sigv4';
vi.mock('../aws/sigv4', () => ({ presignUrl: vi.fn(async (input: { headers: Record<string, string>; region: string }) =>
  `https://sts.${input.region}.amazonaws.com/?signed-cluster=${input.headers['x-k8s-aws-id']}`) }));
it('signs and caches EKS tokens by cluster and region without reusing the other cluster bearer', async () => {
  const alpha = await mintEksToken('alpha-token-test', 'us-east-1');
  const beta = await mintEksToken('beta-token-test', 'us-east-1');
  expect(alpha.token).not.toBe(beta.token);
  expect(Buffer.from(alpha.token.slice('k8s-aws-v1.'.length), 'base64url').toString()).toContain('signed-cluster=alpha-token-test');
  expect(Buffer.from(beta.token.slice('k8s-aws-v1.'.length), 'base64url').toString()).toContain('signed-cluster=beta-token-test');
  expect(await mintEksToken('alpha-token-test', 'us-east-1')).toEqual(alpha);
  expect(presignUrl).toHaveBeenCalledTimes(2);
});
