import { describe, expect, it } from 'vitest';
import { filterGroups } from './ResourcesPage';

const groups = [
  { service: 'EC2' as const, items: [{ arn: 'a1', service: 'EC2' as const, type: 'instance', name: 'isaac-ws', region: 'us-east-1', details: { state: 'running' } }] },
  { service: 'S3' as const, items: [{ arn: 'arn:aws:s3:::pai-artifacts', service: 'S3' as const, type: 'bucket', name: 'pai-artifacts', region: 'us-east-1' }] },
];

describe('filterGroups', () => {
  it('matches name, type or ARN case-insensitively and drops empty groups', () => {
    expect(filterGroups(groups, 'ISAAC').map((g) => g.service)).toEqual(['EC2']);
    expect(filterGroups(groups, 'bucket').map((g) => g.service)).toEqual(['S3']);
    expect(filterGroups(groups, 'arn:aws:s3').map((g) => g.service)).toEqual(['S3']);
    expect(filterGroups(groups, '')).toHaveLength(2);
  });
});
