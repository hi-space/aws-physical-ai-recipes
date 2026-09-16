import { describe, expect, it } from 'vitest';
import { fsxPathToS3, loadConfig } from './config';

describe('loadConfig', () => {
  it('requires TABLE_NAME in alb mode', () => {
    expect(() => loadConfig({ AUTH_MODE: 'alb' })).toThrow(/TABLE_NAME/);
  });
  it('tolerates a bare env in dev mode', () => {
    const c = loadConfig({ AUTH_MODE: 'dev' });
    expect(c.authMode).toBe('dev');
    expect(c.eks).toBeUndefined();
    expect(c.tableName).toBe('physical-ai-dashboard-dev');
  });
  it('treats empty strings as unset', () => {
    const c = loadConfig({ AUTH_MODE: 'dev', DCV_INSTANCE_ID: '' });
    expect(c.dcv).toBeUndefined();
  });
  it('builds the eks section only when all required keys exist', () => {
    const c = loadConfig({
      AUTH_MODE: 'dev',
      EKS_CLUSTER_NAME: 'hyperpod-eks-1',
      HYPERPOD_EKS_CLUSTER_NAME: 'hyperpod-eks-1',
      EKS_DATA_BUCKET: 'b',
      ACCOUNT_ID: '123',
    });
    expect(c.eks?.logGroupPrefix).toBe('/aws/sagemaker/Clusters/hyperpod-eks-1');
    expect(c.edge?.thingGroup).toBe('groot-123-group');
  });
});

describe('fsxPathToS3', () => {
  it('maps DRA-exported paths', () => {
    expect(fsxPathToS3('/fsx/checkpoints/workflows/abc/train', 'bkt')).toBe('s3://bkt/checkpoints/workflows/abc/train');
    expect(fsxPathToS3('/fsx/datasets', 'bkt')).toBe('s3://bkt/datasets/');
  });
  it('returns undefined for scratch', () => {
    expect(fsxPathToS3('/fsx/scratch/x', 'bkt')).toBeUndefined();
  });
});
