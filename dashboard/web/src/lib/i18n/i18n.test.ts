import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, interpolate, localeFromAcceptLanguage, localeFromCookieHeader, negotiateLocale, translate, useFormat, useT } from './index';
import { catalog } from './messages';
import { ago, fmtDuration } from '@/lib/format';

describe('locale negotiation', () => {
  it('prefers the explicit cookie over the browser language', () => {
    expect(negotiateLocale({ cookie: 'pai-project=a; pai-locale=en', acceptLanguage: 'ko-KR,ko;q=0.9' })).toBe('en');
    expect(localeFromCookieHeader('pai-locale=fr')).toBeUndefined();
  });
  it('picks the highest-weighted supported language and falls back to Korean', () => {
    expect(localeFromAcceptLanguage('en-US,en;q=0.9,ko;q=0.8')).toBe('en');
    expect(localeFromAcceptLanguage('fr-FR,fr;q=0.9,ko;q=0.5,en;q=0.7')).toBe('en');
    expect(localeFromAcceptLanguage('de')).toBeUndefined();
    expect(negotiateLocale({ acceptLanguage: 'de' })).toBe('ko');
    expect(negotiateLocale({})).toBe('ko');
  });
});

describe('messages', () => {
  it('interpolates named placeholders and leaves unknown ones visible', () => {
    expect(interpolate('{count} items on page {page}', { count: 3, page: 2 })).toBe('3 items on page 2');
    expect(interpolate('{missing} stays', {})).toBe('{missing} stays');
  });
  it('resolves both locales and falls back to the key for unknown messages', () => {
    expect(translate('en', 'common', 'save')).toBe('Save');
    expect(translate('ko', 'common', 'save')).toBe('저장');
    expect(translate('ko', 'common', 'nope' as never)).toBe('common.nope');
  });
  it('keeps every namespace complete in both locales with no empty or untranslated text', () => {
    for (const [ns, messages] of Object.entries(catalog)) {
      const en = messages.en as Record<string, string>;
      const ko = messages.ko as Record<string, string>;
      expect(Object.keys(ko).sort(), ns).toEqual(Object.keys(en).sort());
      for (const [key, value] of Object.entries(en)) {
        expect(value.trim(), `${ns}.${key} (en)`).not.toBe('');
        expect(ko[key].trim(), `${ns}.${key} (ko)`).not.toBe('');
        // Placeholders must match so a translation cannot drop a variable.
        expect((ko[key].match(/\{\w+\}/g) ?? []).sort(), `${ns}.${key} placeholders`).toEqual((value.match(/\{\w+\}/g) ?? []).sort());
      }
    }
  });
});

describe('React bindings', () => {
  function Probe() {
    const t = useT('common');
    const f = useFormat();
    return createElement('p', null, `${t('save')}|${t('items', { count: 2 })}|${f.fmtDuration(65_000)}|${f.locale}`);
  }
  it('uses the provider locale', () => {
    expect(renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en', children: createElement(Probe) }))).toContain('Save|2 items|1m 5s|en');
    expect(renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'ko', children: createElement(Probe) }))).toContain('저장|2개|1분 5초|ko');
  });
  it('defaults to Korean without a provider (unit tests, fixtures)', () => {
    expect(renderToStaticMarkup(createElement(Probe))).toContain('저장|2개|1분 5초|ko');
  });
});

describe('locale-aware formatters', () => {
  it('renders durations and relative time in Korean words', () => {
    expect(fmtDuration(90 * 60_000, 'ko')).toBe('1시간 30분');
    expect(fmtDuration(90 * 60_000)).toBe('1h 30m');
    expect(ago(Date.now() - 5 * 60_000, 'ko')).toBe('5분 0초 전');
    expect(ago(Date.now() - 5 * 60_000)).toBe('5m 0s ago');
  });
});
