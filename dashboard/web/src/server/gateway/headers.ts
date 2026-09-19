import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { COOKIE_NAME } from './auth';
import type { GatewayRoute } from './routing';
import { GatewayError } from './types';

const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);
const identityHeader = /^(?:authorization|forwarded|x-(?:amzn-|amz-|pai-|forwarded-|auth-|authenticated-|remote-|user(?:-|$)|email$|original-(?:url|uri|host)$|rewrite-url$))/i;
const reservedCookie = (name: string) => name === COOKIE_NAME ||
  /^(?:__Host-pai-|__Secure-pai-|pai-|AWSELBAuthSessionCookie|AWSALB)/i.test(name);

function cleaned(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connection = new Set(String(headers.connection ?? '').toLowerCase().split(',').map((v) => v.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([key, value]) =>
    value !== undefined && !hopHeaders.has(key) && !connection.has(key) && !identityHeader.test(key)));
}

/** Path mode shares one origin across sessions, so `downstreamHeaders` renames app `__Host-` cookies to
 * `pai-app-` on the way out (the prefix bans a Path other than `/`). Coming back in we must (a) restore that
 * rename and (b) strip only the gateway's own session cookies (`pai-session-*`, plus the host-mode name for
 * safety) — never the broad `pai-` scrub, which would eat the app's own round-tripped cookie. Host mode keeps
 * the full reserved-cookie scrub unchanged. */
function upstreamCookie(header: string | undefined, route: GatewayRoute): string | undefined {
  const kept = (header ?? '').split(';').map((v) => v.trim()).filter(Boolean).flatMap((pair) => {
    const at = pair.indexOf('=');
    if (at <= 0) return [];
    const name = pair.slice(0, at);
    if (route.mode === 'host') return reservedCookie(name) ? [] : [pair];
    if (name === COOKIE_NAME || /^pai-session-/i.test(name)) return [];
    if (name.startsWith('pai-app-')) return [`__Host-${name.slice('pai-app-'.length)}=${pair.slice(at + 1)}`];
    return [pair];
  });
  return kept.length ? kept.join('; ') : undefined;
}

export function upstreamHeaders(headers: IncomingHttpHeaders, route: GatewayRoute, websocket = false): OutgoingHttpHeaders {
  const origin = new URL(route.publicOrigin);
  const out = cleaned(headers);
  out.host = origin.host;
  out['x-forwarded-host'] = origin.host;
  out['x-forwarded-proto'] = origin.protocol.replace(/:$/, '');
  // The app renders links under its public prefix; host mode has none and must not advertise one.
  if (route.mode === 'path') out['x-forwarded-prefix'] = route.prefix;
  const cookie = upstreamCookie(headers.cookie, route);
  if (cookie) out.cookie = cookie;
  else delete out.cookie;
  if (headers.referer) {
    try {
      const referer = new URL(headers.referer);
      if (referer.origin === origin.origin) {
        referer.searchParams.delete('ticket');
        out.referer = referer.toString();
      } else delete out.referer;
    } catch { delete out.referer; }
  }
  if (websocket) {
    out.connection = 'Upgrade';
    out.upgrade = 'websocket';
  } else {
    for (const key of Object.keys(out)) if (key.startsWith('sec-websocket-')) delete out[key];
  }
  // Never let a client ask the upstream for a second HTTP authentication scheme.
  delete out.expect;
  return out;
}

/** App cookies keep their name/value, but can never escape or replace the gateway cookie. In path mode
 * each cookie is re-scoped under the session prefix (a shared origin hosts many sessions), the `__Host-`
 * prefix is dropped because it forbids a Path other than `/`, and `Secure` follows the public scheme. */
export function isolatedCookies(cookies: string[] | undefined, route: GatewayRoute): string[] {
  const path = route.mode === 'path';
  const secureOrigin = route.publicOrigin.startsWith('https:');
  return (cookies ?? []).flatMap((cookie) => {
    const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    if (index < 1 || reservedCookie(pair.slice(0, index))) return [];
    let name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    let kept = attributes.filter((attribute) => !/^domain\s*=/i.test(attribute));
    if (path) {
      // The `__Host-` prefix bans any Path other than `/`; rename so the cookie can carry the session prefix.
      if (name.startsWith('__Host-')) name = `pai-app-${name.slice('__Host-'.length)}`;
      const existing = kept.find((attribute) => /^path\s*=/i.test(attribute));
      const original = existing ? existing.slice(existing.indexOf('=') + 1).trim() || '/' : '/';
      kept = kept.filter((attribute) => !/^(?:path\s*=|secure$)/i.test(attribute));
      kept.unshift(`Path=${route.prefix}${original}`);
      if (secureOrigin) kept.push('Secure');
    } else {
      if (name.startsWith('__Host-')) {
        kept = kept.filter((attribute) => !/^path\s*=/i.test(attribute));
        kept.push('Path=/');
      }
      if (!kept.some((attribute) => /^secure$/i.test(attribute))) kept.push('Secure');
    }
    return [[`${name}=${value}`, ...kept].join('; ')];
  });
}

/** `frameAncestors`: allow this exact origin (the dashboard) to embed the app in an iframe. The upstream's
 * own X-Frame-Options/frame-ancestors are replaced; the app still runs on the isolated session origin.
 * http/port origins are permitted so path-mode deployments behind a plain-HTTP dashboard can still embed. */
export function downstreamHeaders(headers: IncomingHttpHeaders, route: GatewayRoute, websocket = false, requestPath = '/', frameAncestors?: string): OutgoingHttpHeaders {
  const origin = new URL(route.publicOrigin);
  const out = cleaned(headers);
  if (frameAncestors) {
    if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(frameAncestors)) throw new GatewayError(500, 'Invalid frame ancestor origin');
    delete out['x-frame-options'];
    const existing = ([] as string[]).concat(out['content-security-policy'] as string | string[] | undefined ?? [])
      .flatMap(v => v.split(';')).map(v => v.trim()).filter(v => v && !/^frame-ancestors\b/i.test(v));
    out['content-security-policy'] = [...existing, `frame-ancestors 'self' ${frameAncestors}`].join('; ');
  }
  delete out['clear-site-data'];
  delete out['alt-svc'];
  delete out.refresh;
  // Link preload targets are allowed to refer to the app, never the private transport endpoint.
  delete out['content-location'];
  // Path mode shares one origin across sessions; a Service-Worker-Allowed wider than the
  // session's own `/s/<id>/` scope would let a Pod observe other sessions on that origin.
  // Host mode has no such shared origin, so its header passes through unchanged.
  if (route.mode === 'path') delete out['service-worker-allowed'];
  const cookies = isolatedCookies(headers['set-cookie'], route);
  if (cookies.length) out['set-cookie'] = cookies;
  else delete out['set-cookie'];
  if (headers.location) {
    const base = new URL(requestPath, `${origin.origin}/`);
    const url = new URL(headers.location, base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new GatewayError(502, 'Unsupported application redirect');
    if (route.mode === 'host') {
      // The app only ever answers on the isolated session host; every redirect target lands back there.
      url.protocol = 'https:';
      url.host = origin.host;
      url.port = '';
      url.username = '';
      url.password = '';
      if (url.searchParams.has('ticket')) url.searchParams.delete('ticket');
      out.location = url.toString();
    } else if (url.origin === base.origin) {
      // Same-origin (app) redirect: re-scope under the session prefix. Foreign origins are left untouched.
      if (url.searchParams.has('ticket')) url.searchParams.delete('ticket');
      const scoped = url.pathname === route.prefix || url.pathname.startsWith(`${route.prefix}/`)
        ? url.pathname : `${route.prefix}${url.pathname}`;
      out.location = `${route.publicOrigin}${scoped}${url.search}${url.hash}`;
    }
  }
  out['cache-control'] = 'no-store';
  out['referrer-policy'] = 'no-referrer';
  if (websocket) {
    out.connection = 'Upgrade';
    out.upgrade = 'websocket';
  }
  return out;
}
