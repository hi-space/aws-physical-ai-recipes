import { describe, expect, it } from 'vitest';
import { downstreamHeaders, upstreamHeaders } from './headers';
import type { GatewayRoute } from './routing';

const host = 'abc.apps.physical-ai.example.com';
const hostRoute: GatewayRoute = { mode: 'host', sessionId: 'abc', binding: host, publicOrigin: `https://${host}`, prefix: '', rest: '/' };
const pathRoute: GatewayRoute = { mode: 'path', sessionId: 'abc', binding: 'http://alb:8080/s/abc', publicOrigin: 'http://alb:8080', prefix: '/s/abc', rest: '/lab' };

describe('downstreamHeaders frame embedding', () => {
  it('keeps the app frame policy by default', () => {
    const out = downstreamHeaders({ 'x-frame-options': 'DENY', 'content-type': 'text/html' }, hostRoute);
    expect(out['x-frame-options']).toBe('DENY');
    expect(out['content-security-policy']).toBeUndefined();
  });
  it('replaces X-Frame-Options with a frame-ancestors policy for the dashboard origin only', () => {
    const out = downstreamHeaders({ 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }, hostRoute, false, '/', 'https://physical-ai.example.com');
    expect(out['x-frame-options']).toBeUndefined();
    expect(out['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'self' https://physical-ai.example.com");
    expect(downstreamHeaders({}, hostRoute, false, '/', 'https://physical-ai.example.com')['content-security-policy']).toBe("frame-ancestors 'self' https://physical-ai.example.com");
  });
  it('rejects a malformed embedder origin but allows http and port origins for path deployments', () => {
    expect(() => downstreamHeaders({}, hostRoute, false, '/', "https://x.example.com 'unsafe-inline'")).toThrow(/frame ancestor/);
    // An origin carrying a path or query is not a bare origin and must be rejected.
    expect(() => downstreamHeaders({}, hostRoute, false, '/', 'http://plain.example.com/x')).toThrow(/frame ancestor/);
    expect(() => downstreamHeaders({}, hostRoute, false, '/', 'http://a.example.com?x')).toThrow(/frame ancestor/);
    expect(downstreamHeaders({}, pathRoute, false, '/lab', 'http://alb:8080')['content-security-policy']).toBe("frame-ancestors 'self' http://alb:8080");
  });
});

describe('downstreamHeaders Service-Worker-Allowed', () => {
  it('drops Service-Worker-Allowed in path mode (shared origin) but keeps it in host mode', () => {
    expect(downstreamHeaders({ 'service-worker-allowed': '/' }, pathRoute)['service-worker-allowed']).toBeUndefined();
    expect(downstreamHeaders({ 'service-worker-allowed': '/' }, hostRoute)['service-worker-allowed']).toBe('/');
  });
});

describe('upstreamHeaders and cookie isolation', () => {
  it('path mode: adds X-Forwarded-Prefix, prefixes root-relative Location and scopes Set-Cookie paths', () => {
    const up = upstreamHeaders({ host: 'alb:8080', cookie: 'pai-session-abc=x; pai-app-csrf=1; theme=dark; pai-session-other=y' }, pathRoute);
    expect(up).toMatchObject({ host: 'alb:8080', 'x-forwarded-prefix': '/s/abc', 'x-forwarded-proto': 'http', cookie: '__Host-csrf=1; theme=dark' });
    expect(upstreamHeaders({ host: 'alb:8080', cookie: 'pai-session-abc=x; theme=dark' }, pathRoute).cookie).toBe('theme=dark');
    const down = downstreamHeaders({ location: '/lab/tree', 'set-cookie': ['sid=1; Path=/; Secure', '__Host-app=2; Path=/; Secure'] }, pathRoute, false, '/lab');
    expect(down.location).toBe('http://alb:8080/s/abc/lab/tree');
    expect(down['set-cookie']).toEqual(['sid=1; Path=/s/abc/', 'pai-app-app=2; Path=/s/abc/']);
  });
  it('host mode does not forward a prefix and keeps cookie isolation on the session host', () => {
    const up = upstreamHeaders({ host, cookie: '__Host-pai-session=x; theme=dark' }, hostRoute);
    expect(up['x-forwarded-prefix']).toBeUndefined();
    expect(up['x-forwarded-proto']).toBe('https');
    expect(up.host).toBe(host);
    expect(up.cookie).toBe('theme=dark');
    const down = downstreamHeaders({ 'set-cookie': ['app=abc; Domain=.physical-ai.example.com; Path=/lab; HttpOnly'] }, hostRoute);
    expect(down['set-cookie']).toEqual(['app=abc; Path=/lab; HttpOnly; Secure']);
  });
});
