/**
 * Client-side guard against a compromised or misissued launch URL before the browser is sent
 * there. The gateway mode determines what a "safe" origin/path looks like: host mode isolates
 * sessions on a subdomain (`<sessionId>.apps.<domain>`), path mode isolates them under a fixed
 * gateway origin with a `/s/<sessionId>/` prefix (`GATEWAY_MODE=path`).
 */
export function isSafeLaunchUrl(
  url: URL,
  sessionId: string,
  gateway: { mode: 'host' | 'path'; origin?: string } | undefined,
): boolean {
  if (url.username || url.password || !url.searchParams.get('ticket')) return false;
  if (gateway?.mode === 'path') return !!gateway.origin && url.origin === gateway.origin && url.pathname.startsWith(`/s/${sessionId}/`);
  return url.protocol === 'https:' && url.hostname.startsWith(`${sessionId}.`);
}
