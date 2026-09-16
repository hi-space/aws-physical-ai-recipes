import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { isPublicWebhookAddress, parseWebhookUrl, postWebhook, resolveWebhookTarget, signWebhook, type WebhookRequestFactory } from './webhook-http';

describe('webhook destination policy', () => {
  it.each([
    'http://hooks.example.com/path', 'https://user:secret@hooks.example.com/path',
    'https://127.0.0.1/x', 'https://2130706433/x', 'https://0x7f000001/x',
    'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://hooks.local/x',
    'https://service.internal/x', 'https://service.corp/x', 'https://service.localdomain/x', 'https://localhost/x', 'https://singlelabel/x',
    'https://hooks.example.com:8443/x', 'https://hooks.example.com./x',
    'https://hooks.example.com/path#fragment',
  ])('refuses unsafe or ambiguous URL %s', url => {
    expect(() => parseWebhookUrl(url)).toThrow();
  });
  it.each(['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.31.2.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.2',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:10.0.0.1',
    '64:ff9b::a00:1', 'fd00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::',
    '2001::1', '3fff::1'])('excludes private, translated, or reserved address %s', address => {
    expect(isPublicWebhookAddress(address)).toBe(false);
  });
  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])('permits public unicast %s', address => {
    expect(isPublicWebhookAddress(address)).toBe(true);
  });
  it('rejects mixed DNS answers and revalidates a rebinding answer on each attempt', async () => {
    const lookup = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    const signal = new AbortController().signal;
    const target = await resolveWebhookTarget('https://hooks.example.com/private/path?key=hidden', signal, lookup);
    expect(target).toMatchObject({ hostname: 'hooks.example.com', address: '93.184.216.34', family: 4 });
    await expect(resolveWebhookTarget('https://hooks.example.com/private/path', signal, lookup)).rejects.toMatchObject({ code: 'destination_invalid' });
  });
});

describe('pinned HTTPS transport and signing', () => {
  const target = { hostname: 'hooks.example.com', address: '93.184.216.34', family: 4 as const, path: '/secret-path?key=private' };
  function fixture(status: number, bytes = 0) {
    let options: RequestOptions | undefined, body = '';
    let callback: (res: IncomingMessage) => void;
    const request = new EventEmitter() as ClientRequest;
    request.setTimeout = (() => request) as ClientRequest['setTimeout'];
    request.destroy = ((error?: Error) => { if (error) queueMicrotask(() => request.emit('error', error)); return request; }) as ClientRequest['destroy'];
    request.end = ((value: string) => {
      body = value;
      queueMicrotask(() => {
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = status; response.headers = { location: 'https://evil.example/steal' };
        response.destroy = (() => response) as IncomingMessage['destroy'];
        callback(response);
        if (bytes) response.emit('data', Buffer.alloc(bytes));
        response.emit('end');
      });
      return request;
    }) as ClientRequest['end'];
    const factory: WebhookRequestFactory = (input, handler) => { options = input; callback = handler; return request; };
    return { factory, options: () => options!, body: () => body };
  }
  it('pins the connection address and keeps hostname verification enabled without following redirects', async () => {
    const f = fixture(302);
    const headers = signWebhook('evt-fixture', '{"status":"FAILED"}', 's'.repeat(32), 1_700_000_000_000);
    expect(await postWebhook(target, '{"status":"FAILED"}', headers, new AbortController().signal, f.factory)).toBe(302);
    expect(f.options()).toMatchObject({ hostname: '93.184.216.34', servername: 'hooks.example.com', port: 443,
      rejectUnauthorized: true, agent: false, method: 'POST' });
    expect(f.options().headers).toMatchObject({ host: 'hooks.example.com', 'content-type': 'application/json' });
    expect(f.body()).toBe('{"status":"FAILED"}');
  });
  it('refuses oversized receiver bodies without retaining their contents', async () => {
    const f = fixture(200, 65537);
    await expect(postWebhook(target, '{}', {}, new AbortController().signal, f.factory)).rejects.toMatchObject({ code: 'response_limit' });
  });
  it('does not connect for an aborted attempt or a forged private pin', async () => {
    const factory = vi.fn();
    const stopped = new AbortController(); stopped.abort();
    await expect(postWebhook(target, '{}', {}, stopped.signal, factory)).rejects.toThrow();
    await expect(postWebhook({ ...target, address: '127.0.0.1' }, '{}', {}, new AbortController().signal, factory)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it('signs exact bytes with timestamp and event ID, independently reproducible by a receiver', () => {
    const body = '{"runId":"r","projectId":"a","status":"FAILED"}', secret = 's'.repeat(32);
    const headers = signWebhook('evt-one', body, secret, 1_700_000_000_123);
    expect(headers['x-pai-timestamp']).toBe('1700000000');
    expect(headers['x-pai-event-id']).toBe('evt-one');
    expect(headers['x-pai-signature']).toBe('v1=' + createHmac('sha256', secret).update('1700000000.evt-one.' + body).digest('hex'));
    expect(JSON.stringify(headers)).not.toContain(secret);
  });
});
