'use client';
import * as React from 'react';
import type { MessageKey, Namespace } from './messages';
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, translatorFor, type Locale, type Translator } from './locale';
import { ago as agoBase, elapsed as elapsedBase, fmtBytes, fmtDuration as fmtDurationBase, fmtNum as fmtNumBase, fmtTime as fmtTimeBase, fmtUsd as fmtUsdBase } from '@/lib/format';

export * from './locale';

// ---------------------------------------------------------------- React
interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}
const I18nContext = React.createContext<I18nContextValue | null>(null);

function writeLocaleCookie(locale: Locale) {
  if (typeof document === 'undefined') return;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  document.documentElement.lang = locale;
}

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: React.ReactNode }) {
  const [locale, setLocaleState] = React.useState<Locale>(initialLocale);
  const setLocale = React.useCallback((next: Locale) => {
    setLocaleState(next);
    writeLocaleCookie(next);
  }, []);
  const value = React.useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return React.createElement(I18nContext.Provider, { value }, children);
}

/** Fallback for components rendered without a provider (unit tests, fixtures): trust `<html lang>` when present. */
function fallbackLocale(): Locale {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement.lang?.toLowerCase().split('-')[0];
    if (isLocale(lang)) return lang;
  }
  return DEFAULT_LOCALE;
}

export function useLocale(): Locale {
  const ctx = React.useContext(I18nContext);
  return ctx?.locale ?? fallbackLocale();
}

export function useSetLocale(): (locale: Locale) => void {
  const ctx = React.useContext(I18nContext);
  return ctx?.setLocale ?? writeLocaleCookie;
}

export function useT<NS extends Namespace>(ns: NS): Translator<NS> {
  const locale = useLocale();
  return React.useMemo(() => translatorFor(locale, ns), [locale, ns]);
}

/** Locale-bound formatters; Korean renders relative times and durations in Korean words. */
export function useFormat() {
  const locale = useLocale();
  return React.useMemo(
    () => ({
      locale,
      ago: (iso?: string | number | Date) => agoBase(iso, locale),
      fmtTime: (iso?: string | number | Date) => fmtTimeBase(iso, locale),
      fmtDuration: (ms?: number) => fmtDurationBase(ms, locale),
      elapsed: (start?: string, end?: string) => elapsedBase(start, end, locale),
      fmtNum: (n?: number, digits?: number) => fmtNumBase(n, digits, locale),
      fmtUsd: (n?: number) => fmtUsdBase(n, locale),
      fmtBytes,
    }),
    [locale],
  );
}

export type { Catalog, MessageKey, Namespace } from './messages';
