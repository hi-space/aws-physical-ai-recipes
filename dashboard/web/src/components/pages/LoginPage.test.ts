import { describe, expect, it } from 'vitest';
import { nextStep, safeNext } from './LoginPage';

describe('login helpers', () => {
  it('only follows same-origin absolute paths', () => {
    expect(safeNext('/workflows?x=1')).toBe('/workflows?x=1');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('http://evil.example')).toBe('/');
    expect(safeNext('javascript:alert(1)')).toBe('/');
    expect(safeNext('')).toBe('/');
    expect(safeNext(null)).toBe('/');
    expect(safeNext('/\r\nfoo')).toBe('/');
    expect(safeNext('/\\evil')).toBe('/');
  });
  it('maps API responses to steps', () => {
    expect(nextStep({ status: 200, body: { ok: true } })).toBe('done');
    expect(nextStep({ status: 200, body: { challenge: 'NEW_PASSWORD_REQUIRED', session: 's' } })).toBe('newPassword');
    expect(nextStep({ status: 401, body: { code: 'login_failed' } })).toBe('failed');
  });
});
