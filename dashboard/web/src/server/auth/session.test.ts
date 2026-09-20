import { describe, expect, it } from 'vitest';
import { SESSION_HEADERS, sessionFromHeaders } from './session';

const base = { [SESSION_HEADERS.user]: 'alice', [SESSION_HEADERS.subject]: 'sub-a', [SESSION_HEADERS.role]: 'researcher' };
describe('sessionFromHeaders groups', () => {
  it('parses the comma-separated groups header', () => {
    const s = sessionFromHeaders(new Headers({ ...base, [SESSION_HEADERS.groups]: 'researchers,proj-team-a,' }));
    expect(s.groups).toEqual(['researchers', 'proj-team-a']);
  });
  it('defaults to an empty list when the header is absent', () => {
    expect(sessionFromHeaders(new Headers(base)).groups).toEqual([]);
  });
  it('exposes the header name for proxy.ts', () => {
    expect(SESSION_HEADERS.groups).toBe('x-pai-groups');
  });
});
