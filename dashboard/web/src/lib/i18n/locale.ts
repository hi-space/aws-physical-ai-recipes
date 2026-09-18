import { catalog, type Catalog, type MessageKey, type Namespace } from './messages';

export type Locale = 'ko' | 'en';
export const LOCALES: readonly Locale[] = ['ko', 'en'];
/** Product default: the dashboard was designed Korean-first. Browsers that prefer English get English automatically. */
export const DEFAULT_LOCALE: Locale = 'ko';
export const LOCALE_COOKIE = 'pai-locale';
export const LOCALE_LABELS: Record<Locale, string> = { ko: '한국어', en: 'English' };
/** Compact labels for the sidebar toggle (native name for Korean, ISO code for English). */
export const LOCALE_SHORT_LABELS: Record<Locale, string> = { ko: '한국어', en: 'EN' };

export function isLocale(value: unknown): value is Locale {
  return value === 'ko' || value === 'en';
}

export function localeFromCookieHeader(header?: string | null): Locale | undefined {
  if (!header) return undefined;
  const match = new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`).exec(header);
  const value = match?.[1] && decodeURIComponent(match[1]);
  return isLocale(value) ? value : undefined;
}

/** Highest-q supported language from an Accept-Language header (`ko-KR,ko;q=0.9,en-US;q=0.8` → ko). */
export function localeFromAcceptLanguage(header?: string | null): Locale | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { lang: tag.trim().toLowerCase().split('-')[0], weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((r) => r.lang && r.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  return ranked.find((r) => isLocale(r.lang))?.lang as Locale | undefined;
}

/** Cookie wins (explicit choice), then the browser preference, then the product default. */
export function negotiateLocale(input: { cookie?: string | null; acceptLanguage?: string | null }): Locale {
  return localeFromCookieHeader(input.cookie) ?? localeFromAcceptLanguage(input.acceptLanguage) ?? DEFAULT_LOCALE;
}

export type Vars = Record<string, string | number | undefined>;

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

/** Non-hook lookup for callbacks, tests and server code. Unknown keys return the key itself so the UI never blanks out. */
export function translate<NS extends Namespace>(locale: Locale, ns: NS, key: MessageKey<NS>, vars?: Vars): string {
  const set = (catalog[ns] as Catalog[NS])[locale] as Record<string, string>;
  const template = set[key as string] ?? (catalog[ns].en as Record<string, string>)[key as string];
  if (template === undefined) {
    if (process.env.NODE_ENV !== 'production') console.warn(`[i18n] missing message ${ns}.${String(key)}`);
    return `${ns}.${String(key)}`;
  }
  return interpolate(template, vars);
}

export type Translator<NS extends Namespace> = ((key: MessageKey<NS>, vars?: Vars) => string) & { locale: Locale; ns: NS };

export function translatorFor<NS extends Namespace>(locale: Locale, ns: NS): Translator<NS> {
  const t = ((key: MessageKey<NS>, vars?: Vars) => translate(locale, ns, key, vars)) as Translator<NS>;
  t.locale = locale;
  t.ns = ns;
  return t;
}
