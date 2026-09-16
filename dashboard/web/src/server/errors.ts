export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'error',
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
export const badRequest = (m: string, details?: unknown) => new HttpError(400, m, 'bad_request', details);
export const unauthorized = (m = 'Unauthorized') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Forbidden') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const notConfigured = (what: string) => new HttpError(503, `${what} is not configured in this deployment`, 'not_configured');

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
