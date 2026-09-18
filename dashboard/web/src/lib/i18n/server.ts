import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, negotiateLocale, type Locale } from './locale';

/** Locale for the current request: explicit cookie first, then the browser's Accept-Language, then the default. */
export async function resolveRequestLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const cookie = cookieStore.get(LOCALE_COOKIE)?.value;
  return negotiateLocale({ cookie: cookie ? `${LOCALE_COOKIE}=${cookie}` : null, acceptLanguage: headerStore.get('accept-language') });
}
