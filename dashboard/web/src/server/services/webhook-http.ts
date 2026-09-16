import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { request, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { checkServerIdentity } from 'node:tls';
import { createHmac } from 'node:crypto';

export class WebhookTransportError extends Error {
  constructor(readonly code: string, readonly permanent = false) { super(code); }
}
export interface WebhookTarget { hostname: string; address: string; family: 4 | 6; path: string }
export type WebhookLookup = (hostname: string) => Promise<LookupAddress[]>;
export type WebhookRequestFactory = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
const invalid = () => new WebhookTransportError('destination_invalid', true);
const blocked = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, bits, 'ipv4');
for (const [address, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, bits, 'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicWebhookAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid(); }
  const host = url.hostname.toLowerCase();
  if (raw !== raw.trim() || /[\s\\\x00-\x1f\x7f]/.test(raw) || url.protocol !== 'https:' ||
      url.username || url.password || url.port || url.hash || isIP(host.replace(/^\[|\]$/g, '')) ||
      host.endsWith('.') || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.') ||
      host.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) ||
      /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|private|arpa|test|invalid|example)$/.test(host) ||
      host.length > 253 || Buffer.byteLength(url.href) > 2048) throw invalid();
  return url;
}
export async function resolveWebhookTarget(raw: string, signal: AbortSignal, resolver: WebhookLookup = host => lookup(host, { all: true, verbatim: true })): Promise<WebhookTarget> {
  const url = parseWebhookUrl(raw);
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WebhookTransportError('dns_timeout')), 5000);
      abort = () => reject(new WebhookTransportError('attempt_aborted'));
      signal.addEventListener('abort', abort, { once: true });
    });
    const addresses = await Promise.race([resolver(url.hostname), stopped]);
    signal.throwIfAborted();
    if (!addresses.length || addresses.length > 32 || addresses.some(a => !isPublicWebhookAddress(a.address) || isIP(a.address) !== a.family)) throw invalid();
    const selected = [...addresses].sort((a, b) => a.family - b.family)[0];
    return { hostname: url.hostname, address: selected.address, family: selected.family as 4 | 6, path: url.pathname + url.search };
  } catch (error) {
    if (error instanceof WebhookTransportError) throw error;
    throw new WebhookTransportError('dns_failed');
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}
export function signWebhook(eventId: string, body: string, secret: string, now: number): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  return { 'x-pai-event-id': eventId, 'x-pai-timestamp': timestamp,
    'x-pai-signature': `v1=${createHmac('sha256', secret).update(`${timestamp}.${eventId}.${body}`).digest('hex')}` };
}
/** No DNS lookup occurs here: connect to the checked address and verify TLS for the original hostname. */
export async function postWebhook(target: WebhookTarget, body: string, headers: Record<string, string>, signal: AbortSignal,
  factory: WebhookRequestFactory = (options, callback) => request(options, callback)): Promise<number> {
  signal.throwIfAborted();
  if (!isPublicWebhookAddress(target.address) || isIP(target.address) !== target.family ||
      parseWebhookUrl(`https://${target.hostname}${target.path}`).hostname !== target.hostname) throw invalid();
  if (Buffer.byteLength(body) > 16384) throw new WebhookTransportError('payload_limit', true);
  return new Promise((resolve, reject) => {
    let completed = false, req: ClientRequest | undefined, response: IncomingMessage | undefined;
    const finish = (error?: WebhookTransportError, status?: number) => {
      if (completed) return;
      completed = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) { response?.destroy(); req?.destroy(); reject(error); } else resolve(status!);
    };
    const abort = () => finish(new WebhookTransportError('attempt_aborted'));
    const timer = setTimeout(() => finish(new WebhookTransportError('http_timeout')), 10000);
    signal.addEventListener('abort', abort, { once: true });
    try {
      req = factory({
        hostname: target.address, family: target.family, port: 443, servername: target.hostname,
        rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(target.hostname, cert),
        agent: false, method: 'POST', path: target.path, maxHeaderSize: 16384,
        headers: { ...headers, host: target.hostname, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
          'accept-encoding': 'identity', 'user-agent': 'physical-ai-webhooks/1' },
      }, incoming => {
        response = incoming;
        if (completed) { incoming.destroy(); return; }
        let bytes = 0;
        if (Number(incoming.headers['content-length'] ?? 0) > 65536) return finish(new WebhookTransportError('response_limit', true));
        incoming.on('data', chunk => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 65536) finish(new WebhookTransportError('response_limit', true));
        });
        incoming.on('end', () => {
          const status = incoming.statusCode;
          if (!status || status < 100 || status > 599) return finish(new WebhookTransportError('response_invalid'));
          finish(undefined, status);
        });
        incoming.on('aborted', () => finish(new WebhookTransportError('response_aborted')));
        incoming.on('error', () => finish(new WebhookTransportError('transport_failed')));
      });
      req.on('error', () => finish(new WebhookTransportError('transport_failed')));
      req.setTimeout(5000, () => finish(new WebhookTransportError('http_timeout')));
      if (signal.aborted) abort(); else req.end(body);
    } catch { finish(new WebhookTransportError('transport_failed')); }
  });
}
