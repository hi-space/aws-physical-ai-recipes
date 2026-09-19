import { describe, expect, it } from 'vitest';
import { cookieAttributes, cookieName, gatewayMode, launchUrl, resolveRoute } from './routing';
const host = { baseDomain: 'apps.example.com' };
const path = { mode: 'path' as const, publicOrigin: 'http://alb.example.com:8080' };
describe('host mode (unchanged)', () => {
  it('resolves the session from the host label and keeps the whole path', () => {
    expect(resolveRoute({ host: 'abc.apps.example.com', path: '/lab?x=1' }, host)).toEqual({ mode: 'host', sessionId: 'abc', binding: 'abc.apps.example.com', publicOrigin: 'https://abc.apps.example.com', prefix: '', rest: '/lab?x=1' });
    expect(launchUrl('abc', host)).toEqual({ url: 'https://abc.apps.example.com/?ticket=', binding: 'abc.apps.example.com' });
    expect(cookieName('abc', host)).toBe('__Host-pai-session');
    expect(cookieAttributes('abc', 60, new Date(0), host)).toBe('Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });
});
describe('path mode', () => {
  it('resolves /s/<id>/rest, strips the prefix and binds to origin+prefix', () => {
    expect(resolveRoute({ host: 'alb.example.com:8080', path: '/s/abc/lab/tree?x=1' }, path)).toEqual({ mode: 'path', sessionId: 'abc', binding: 'http://alb.example.com:8080/s/abc', publicOrigin: 'http://alb.example.com:8080', prefix: '/s/abc', rest: '/lab/tree?x=1' });
    expect(resolveRoute({ host: 'alb.example.com:8080', path: '/s/abc' }, path).rest).toBe('/');
    expect(() => resolveRoute({ host: 'alb.example.com:8080', path: '/lab' }, path)).toThrow(/Session authorization/);
    expect(() => resolveRoute({ host: 'alb.example.com:8080', path: '/s/Not_Valid/x' }, path)).toThrow();
    expect(() => resolveRoute({ host: 'other.example.com', path: '/s/abc/' }, path)).toThrow(/Host/);
  });
  it('builds the launch URL, a per-session cookie without the __Host- prefix and Secure only on https', () => {
    expect(launchUrl('abc', path)).toEqual({ url: 'http://alb.example.com:8080/s/abc/?ticket=', binding: 'http://alb.example.com:8080/s/abc' });
    expect(cookieName('abc', path)).toBe('pai-session-abc');
    expect(cookieAttributes('abc', 60, new Date(0), path)).toBe('Path=/s/abc/; HttpOnly; SameSite=Strict; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(cookieAttributes('abc', 60, new Date(0), { ...path, publicOrigin: 'https://gw.example.com' })).toContain('; Secure;');
  });
  it('requires a valid GATEWAY_PUBLIC_ORIGIN', () => {
    expect(() => gatewayMode({ mode: 'path' })).not.toThrow();
    expect(() => launchUrl('abc', { mode: 'path', publicOrigin: 'alb.example.com' })).toThrow(/GATEWAY_PUBLIC_ORIGIN/);
  });
});
