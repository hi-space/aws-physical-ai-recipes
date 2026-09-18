import { describe, expect, it } from 'vitest';
import { downstreamHeaders } from './headers';

describe('downstreamHeaders frame embedding', () => {
  const host = 'abc.apps.physical-ai.example.com';
  it('keeps the app frame policy by default', () => {
    const out = downstreamHeaders({ 'x-frame-options': 'DENY', 'content-type': 'text/html' }, host);
    expect(out['x-frame-options']).toBe('DENY');
    expect(out['content-security-policy']).toBeUndefined();
  });
  it('replaces X-Frame-Options with a frame-ancestors policy for the dashboard origin only', () => {
    const out = downstreamHeaders({ 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }, host, false, '/', 'https://physical-ai.example.com');
    expect(out['x-frame-options']).toBeUndefined();
    expect(out['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'self' https://physical-ai.example.com");
    expect(downstreamHeaders({}, host, false, '/', 'https://physical-ai.example.com')['content-security-policy']).toBe("frame-ancestors 'self' https://physical-ai.example.com");
  });
  it('rejects a malformed embedder origin instead of emitting a broken policy', () => {
    expect(() => downstreamHeaders({}, host, false, '/', "https://x.example.com 'unsafe-inline'")).toThrow(/frame ancestor/);
    expect(() => downstreamHeaders({}, host, false, '/', 'http://plain.example.com')).toThrow(/frame ancestor/);
  });
});
