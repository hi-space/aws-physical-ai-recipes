import { GatewayError, type AuthOptions } from './types';
import { notConfigured } from '../errors';

export type GatewayMode = 'host' | 'path';
export interface GatewayRoute { mode: GatewayMode; sessionId: string; binding: string; publicOrigin: string; prefix: string; rest: string }

export const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const invalid = () => new GatewayError(401, 'Session authorization expired or invalid');

/** Session hosts (`<id>.apps.<domain>`) need a wildcard domain; deployments without one simply have no session features. */
export function baseDomain(options: AuthOptions = {}): string {
  const domain = options.baseDomain ?? process.env.GATEWAY_BASE_DOMAIN;
  if (!domain) throw notConfigured('Session hosts (GATEWAY_BASE_DOMAIN)');
  if (domain.length > 190 || !domain.includes('.') || !domain.split('.').every((part) => labelPattern.test(part))) {
    throw new GatewayError(500, 'Invalid gateway domain configuration');
  }
  return domain;
}

export function sessionHost(id: string, options: AuthOptions = {}): string {
  if (!labelPattern.test(id)) throw invalid();
  return `${id}.${baseDomain(options)}`;
}

/** Do not normalize authorities: aliases, ports, case variants and trailing dots fail closed. */
export function sessionIdFromHost(host: string | undefined, options: AuthOptions = {}): string {
  if (!host) throw invalid();
  const suffix = `.${baseDomain(options)}`;
  if (!host.endsWith(suffix)) throw invalid();
  const id = host.slice(0, -suffix.length);
  if (!labelPattern.test(id) || sessionHost(id, options) !== host) throw invalid();
  return id;
}

export function gatewayMode(o: AuthOptions = {}): GatewayMode {
  const m = o.mode ?? process.env.GATEWAY_MODE ?? 'host';
  if (m !== 'host' && m !== 'path') throw new GatewayError(500, 'GATEWAY_MODE must be host or path');
  return m;
}

export function publicOrigin(o: AuthOptions = {}): string {
  const origin = o.publicOrigin ?? process.env.GATEWAY_PUBLIC_ORIGIN;
  if (!origin) throw notConfigured('Session gateway (GATEWAY_PUBLIC_ORIGIN)');
  if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(origin)) throw new GatewayError(500, 'GATEWAY_PUBLIC_ORIGIN is malformed');
  return origin;
}

export function resolveRoute(req: { host?: string; path: string }, o: AuthOptions = {}): GatewayRoute {
  if (gatewayMode(o) === 'host') {
    const sessionId = sessionIdFromHost(req.host, o);
    return { mode: 'host', sessionId, binding: req.host!, publicOrigin: `https://${req.host}`, prefix: '', rest: req.path };
  }
  const origin = publicOrigin(o);
  if (!req.host || req.host.toLowerCase() !== new URL(origin).host.toLowerCase()) throw new GatewayError(403, 'Host does not match the gateway origin');
  const m = /^\/s\/([^/?#]+)(\/[^#]*|)(\?.*)?$/.exec(req.path);
  if (!m || !labelPattern.test(m[1])) throw invalid();
  const sessionId = m[1], rest = (m[2] || '/') + (m[3] ?? '');
  return { mode: 'path', sessionId, binding: `${origin}/s/${sessionId}`, publicOrigin: origin, prefix: `/s/${sessionId}`, rest };
}

export function launchUrl(sessionId: string, o: AuthOptions = {}): { url: string; binding: string } {
  if (!labelPattern.test(sessionId)) throw invalid();
  if (gatewayMode(o) === 'host') { const host = sessionHost(sessionId, o); return { url: `https://${host}/?ticket=`, binding: host }; }
  const origin = publicOrigin(o);
  return { url: `${origin}/s/${sessionId}/?ticket=`, binding: `${origin}/s/${sessionId}` };
}

export const cookieName = (sessionId: string, o: AuthOptions = {}) => (gatewayMode(o) === 'host' ? '__Host-pai-session' : `pai-session-${sessionId}`);

export function cookieAttributes(sessionId: string, maxAge: number, expires: Date, o: AuthOptions = {}): string {
  if (gatewayMode(o) === 'host') return `Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Expires=${expires.toUTCString()}`;
  const secure = publicOrigin(o).startsWith('https:') ? ' Secure;' : '';
  return `Path=/s/${sessionId}/;${secure} HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Expires=${expires.toUTCString()}`;
}
