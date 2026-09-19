import { describe, expect, it } from 'vitest';
import { isSafeLaunchUrl } from './session-url';

describe('isSafeLaunchUrl', () => {
  it('passes a host-mode launch URL on the session subdomain', () => {
    const url = new URL('https://sess-1.apps.physical-ai.hi-yoo.com/?ticket=abc');
    expect(isSafeLaunchUrl(url, 'sess-1', undefined)).toBe(true);
    expect(isSafeLaunchUrl(url, 'sess-1', { mode: 'host' })).toBe(true);
  });
  it('fails a host-mode URL missing a ticket, on http, or on the wrong session subdomain', () => {
    expect(isSafeLaunchUrl(new URL('https://sess-1.apps.physical-ai.hi-yoo.com/'), 'sess-1', undefined)).toBe(false);
    expect(isSafeLaunchUrl(new URL('http://sess-1.apps.physical-ai.hi-yoo.com/?ticket=abc'), 'sess-1', undefined)).toBe(false);
    expect(isSafeLaunchUrl(new URL('https://sess-2.apps.physical-ai.hi-yoo.com/?ticket=abc'), 'sess-1', undefined)).toBe(false);
  });
  it('passes a path-mode launch URL under the gateway origin and session prefix', () => {
    const url = new URL('http://alb.example.com:8080/s/sess-1/?ticket=abc');
    expect(isSafeLaunchUrl(url, 'sess-1', { mode: 'path', origin: 'http://alb.example.com:8080' })).toBe(true);
  });
  it('fails a path-mode URL on a different origin', () => {
    const url = new URL('http://evil.example.com/s/sess-1/?ticket=abc');
    expect(isSafeLaunchUrl(url, 'sess-1', { mode: 'path', origin: 'http://alb.example.com:8080' })).toBe(false);
  });
  it("fails a path-mode URL under a different session's prefix", () => {
    const url = new URL('http://alb.example.com:8080/s/sess-2/?ticket=abc');
    expect(isSafeLaunchUrl(url, 'sess-1', { mode: 'path', origin: 'http://alb.example.com:8080' })).toBe(false);
  });
});
