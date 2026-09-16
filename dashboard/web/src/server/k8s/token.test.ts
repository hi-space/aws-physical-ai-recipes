import { describe, expect, it } from 'vitest';
import { encodeEksToken } from './token';
import { assertWritableNamespace } from './client';
import { fsxPvManifests } from './resources';

describe('encodeEksToken', () => {
  it('prefixes and base64url-encodes without padding', () => {
    const url = 'https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15&X-Amz-Signature=abc';
    const tok = encodeEksToken(url);
    expect(tok.startsWith('k8s-aws-v1.')).toBe(true);
    expect(tok).not.toMatch(/=/);
    expect(Buffer.from(tok.slice('k8s-aws-v1.'.length), 'base64url').toString()).toBe(url);
  });
});

describe('assertWritableNamespace', () => {
  it('blocks system namespaces and invalid names', () => {
    expect(() => assertWritableNamespace('kube-system')).toThrow(/system/);
    expect(() => assertWritableNamespace('Bad_Name')).toThrow(/Invalid/);
    expect(() => assertWritableNamespace('rl')).not.toThrow();
  });
});

describe('fsxPvManifests', () => {
  it('matches k8s-templates/fsx-pvc.yaml', () => {
    const { pv, pvc } = fsxPvManifests('rl', 'fs-1', 'fs-1.fsx.us-east-1.amazonaws.com', 'abcd');
    expect(pv.metadata.name).toBe('fsx-pv-rl');
    expect(pv.spec.csi).toEqual({ driver: 'fsx.csi.aws.com', volumeHandle: 'fs-1', volumeAttributes: { dnsname: 'fs-1.fsx.us-east-1.amazonaws.com', mountname: 'abcd' } });
    expect(pv.spec.mountOptions).toEqual(['flock']);
    expect(pvc.spec.volumeName).toBe('fsx-pv-rl');
    expect(pvc.spec.storageClassName).toBe('fsx-sc');
  });
});
