import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

export interface SigV4FetchInput {
  service: string;
  region: string;
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

const signers = new Map<string, SignatureV4>();
function signer(service: string, region: string): SignatureV4 {
  const k = `${service}/${region}`;
  let s = signers.get(k);
  if (!s) {
    s = new SignatureV4({ service, region, credentials: defaultProvider(), sha256: Sha256 });
    signers.set(k, s);
  }
  return s;
}

/** Sign an arbitrary HTTPS request with SigV4 and send it with fetch. */
export async function sigv4Fetch(input: SigV4FetchInput): Promise<Response> {
  const url = new URL(input.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (query[k] = v));
  const req = new HttpRequest({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    method: input.method ?? 'GET',
    path: url.pathname,
    query,
    headers: { host: url.host, ...(input.headers ?? {}) },
    body: input.body,
  });
  const signed = await signer(input.service, input.region).sign(req);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(signed.headers)) if (k.toLowerCase() !== 'host') headers[k] = String(v);
  return fetch(url.toString(), { method: req.method, headers, body: input.body });
}

/** Presign a request (used for the EKS bearer token). */
export async function presignUrl(input: SigV4FetchInput & { expiresIn: number }): Promise<string> {
  const url = new URL(input.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (query[k] = v));
  const req = new HttpRequest({
    protocol: url.protocol,
    hostname: url.hostname,
    method: input.method ?? 'GET',
    path: url.pathname,
    query,
    headers: { host: url.host, ...(input.headers ?? {}) },
  });
  const presigned = await signer(input.service, input.region).presign(req, { expiresIn: input.expiresIn });
  const qs = Object.entries(presigned.query ?? {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v[0] : String(v))}`)
    .join('&');
  return `${presigned.protocol}//${presigned.hostname}${presigned.path}?${qs}`;
}
