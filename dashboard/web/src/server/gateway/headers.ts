import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { COOKIE_NAME } from './auth';
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

export function upstreamHeaders(headers: IncomingHttpHeaders, host: string, websocket = false): OutgoingHttpHeaders {
  const out = cleaned(headers);
  out.host = host;
  out['x-forwarded-host'] = host;
  out['x-forwarded-proto'] = 'https';
  const cookies = (headers.cookie ?? '').split(';').map((v) => v.trim()).filter((v) => {
    const at = v.indexOf('=');
    return at > 0 && !reservedCookie(v.slice(0, at));
  });
  if (cookies.length) out.cookie = cookies.join('; ');
  else delete out.cookie;
  if (headers.referer) {
    try {
      const referer = new URL(headers.referer);
      if (referer.origin === `https://${host}`) {
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

/** App cookies keep their name/path, but can never escape or replace the gateway cookie. */
export function isolatedCookies(cookies: string[] | undefined): string[] {
  return (cookies ?? []).flatMap((cookie) => {
    const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    if (index < 1 || reservedCookie(pair.slice(0, index))) return [];
    const name = pair.slice(0, index);
    let kept = attributes.filter((attribute) => !/^domain\s*=/i.test(attribute));
    if (name.startsWith('__Host-')) {
      kept = kept.filter((attribute) => !/^path\s*=/i.test(attribute));
      kept.push('Path=/');
    }
    if (!kept.some((attribute) => /^secure$/i.test(attribute))) kept.push('Secure');
    return [[pair, ...kept].join('; ')];
  });
}

export function downstreamHeaders(headers: IncomingHttpHeaders, host: string, websocket = false, requestPath = '/'): OutgoingHttpHeaders {
  const out = cleaned(headers);
  delete out['clear-site-data'];
  delete out['alt-svc'];
  delete out.refresh;
  // Link preload targets are allowed to refer to the app, never the private transport endpoint.
  delete out['content-location'];
  const cookies = isolatedCookies(headers['set-cookie']);
  if (cookies.length) out['set-cookie'] = cookies;
  else delete out['set-cookie'];
  if (headers.location) {
    const url = new URL(headers.location, new URL(requestPath, `https://${host}/`));
    if (!['http:', 'https:'].includes(url.protocol)) throw new GatewayError(502, 'Unsupported application redirect');
    url.protocol = 'https:';
    url.host = host;
    url.port = '';
    url.username = '';
    url.password = '';
    if (url.searchParams.has('ticket')) url.searchParams.delete('ticket');
    out.location = url.toString();
  }
  out['cache-control'] = 'no-store';
  out['referrer-policy'] = 'no-referrer';
  if (websocket) {
    out.connection = 'Upgrade';
    out.upgrade = 'websocket';
  }
  return out;
}
