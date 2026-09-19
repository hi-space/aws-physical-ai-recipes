import { describe, expect, it } from 'vitest';
import { fsxPathToS3, loadConfig } from './config';

describe('loadConfig', () => {
  it('refuses development authentication in a deployed process', () => {
    expect(() => loadConfig({ AUTH_MODE: 'dev', NODE_ENV: 'production' })).toThrow(/development authentication/);
    expect(() => loadConfig({ AUTH_MODE: 'dev', NODE_ENV: 'test', AWS_EXECUTION_ENV: 'AWS_ECS_FARGATE' })).toThrow(/development authentication/);
  });
  it('requires TABLE_NAME in alb mode', () => {
    expect(() => loadConfig({ AUTH_MODE: 'alb' } as unknown as NodeJS.ProcessEnv)).toThrow(/TABLE_NAME/);
  });
  it('tolerates a bare env in dev mode', () => {
    const c = loadConfig({ AUTH_MODE: 'dev' } as unknown as NodeJS.ProcessEnv);
    expect(c.authMode).toBe('dev');
    expect(c.eks).toBeUndefined();
    expect(c.tableName).toBe('physical-ai-dashboard-dev');
  });
  it('treats empty strings as unset', () => {
    const c = loadConfig({ AUTH_MODE: 'dev', DCV_INSTANCE_ID: '' } as unknown as NodeJS.ProcessEnv);
    expect(c.dcv).toBeUndefined();
  });
  it('builds the eks section only when all required keys exist', () => {
    const c = loadConfig({
      AUTH_MODE: 'dev',
      EKS_CLUSTER_NAME: 'hyperpod-eks-1',
      HYPERPOD_EKS_CLUSTER_NAME: 'hyperpod-eks-1',
      EKS_DATA_BUCKET: 'b',
      ACCOUNT_ID: '123',
    } as unknown as NodeJS.ProcessEnv);
    expect(c.eks?.logGroupPrefix).toBe('/aws/sagemaker/Clusters/hyperpod-eks-1');
    expect(c.edge?.thingGroup).toBeUndefined();
  });
  it('takes the edge thing group from the environment, with no account fallback', () => {
    const c = loadConfig({ AUTH_MODE: 'dev', ACCOUNT_ID: '123', GREENGRASS_THING_GROUP: 'g' } as unknown as NodeJS.ProcessEnv);
    expect(c.edge?.thingGroup).toBe('g');
  });
  it('cognito mode requires app client id and signing key', () => {
    expect(() =>
      loadConfig({
        AUTH_MODE: 'cognito',
        COGNITO_USER_POOL_ID: 'p',
        SESSION_SIGNING_KEY: 'k'.repeat(48),
        DASHBOARD_ORIGIN: 'http://x',
        TABLE_NAME: 't',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/COGNITO_APP_CLIENT_ID/);
    const c = loadConfig({
      AUTH_MODE: 'cognito',
      COGNITO_USER_POOL_ID: 'p',
      COGNITO_APP_CLIENT_ID: 'c',
      SESSION_SIGNING_KEY: 'k'.repeat(48),
      DASHBOARD_ORIGIN: 'http://x',
      TABLE_NAME: 't',
    } as unknown as NodeJS.ProcessEnv);
    expect(c.authMode).toBe('cognito');
    expect(c.cognitoAppClientId).toBe('c');
  });
  it('requires TABLE_NAME in cognito mode even with a complete cognito env', () => {
    expect(() =>
      loadConfig({
        AUTH_MODE: 'cognito',
        COGNITO_USER_POOL_ID: 'p',
        COGNITO_APP_CLIENT_ID: 'c',
        SESSION_SIGNING_KEY: 'k'.repeat(48),
        DASHBOARD_ORIGIN: 'http://x',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/TABLE_NAME/);
  });
  it('defaults gatewayMode to host and tolerates GATEWAY_PUBLIC_ORIGIN being unset', () => {
    const c = loadConfig({ AUTH_MODE: 'dev' } as unknown as NodeJS.ProcessEnv);
    expect(c.gatewayMode).toBe('host');
    expect(c.gatewayPublicOrigin).toBeUndefined();
  });
  it('rejects an unknown GATEWAY_MODE', () => {
    expect(() => loadConfig({ AUTH_MODE: 'dev', GATEWAY_MODE: 'bogus' } as unknown as NodeJS.ProcessEnv)).toThrow(/GATEWAY_MODE/);
  });
  it('accepts path mode with no GATEWAY_PUBLIC_ORIGIN set (feature stays off)', () => {
    const c = loadConfig({ AUTH_MODE: 'dev', GATEWAY_MODE: 'path' } as unknown as NodeJS.ProcessEnv);
    expect(c.gatewayMode).toBe('path');
    expect(c.gatewayPublicOrigin).toBeUndefined();
  });
  it('accepts a bare origin for GATEWAY_PUBLIC_ORIGIN in path mode', () => {
    const c = loadConfig({ AUTH_MODE: 'dev', GATEWAY_MODE: 'path', GATEWAY_PUBLIC_ORIGIN: 'http://alb.example.com:8080' } as unknown as NodeJS.ProcessEnv);
    expect(c.gatewayPublicOrigin).toBe('http://alb.example.com:8080');
  });
  it('rejects a GATEWAY_PUBLIC_ORIGIN with a path, query, or non-http(s) scheme', () => {
    expect(() => loadConfig({ AUTH_MODE: 'dev', GATEWAY_MODE: 'path', GATEWAY_PUBLIC_ORIGIN: 'http://alb.example.com/prefix' } as unknown as NodeJS.ProcessEnv)).toThrow(/GATEWAY_PUBLIC_ORIGIN/);
    expect(() => loadConfig({ AUTH_MODE: 'dev', GATEWAY_MODE: 'path', GATEWAY_PUBLIC_ORIGIN: 'http://alb.example.com?x=1' } as unknown as NodeJS.ProcessEnv)).toThrow(/GATEWAY_PUBLIC_ORIGIN/);
    expect(() => loadConfig({ AUTH_MODE: 'dev', GATEWAY_MODE: 'path', GATEWAY_PUBLIC_ORIGIN: 'ftp://alb.example.com' } as unknown as NodeJS.ProcessEnv)).toThrow(/GATEWAY_PUBLIC_ORIGIN/);
    expect(() => loadConfig({ AUTH_MODE: 'dev', GATEWAY_MODE: 'path', GATEWAY_PUBLIC_ORIGIN: 'not a url' } as unknown as NodeJS.ProcessEnv)).toThrow(/GATEWAY_PUBLIC_ORIGIN/);
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
