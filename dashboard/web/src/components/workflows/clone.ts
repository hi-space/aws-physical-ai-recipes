import { parseDocument } from 'yaml';
import { translate, type Locale } from '@/lib/i18n';

/** Preserve the submitted revision; recorded overrides must survive a new submission. */
export function cloneWorkflowYaml(specYaml: string, vars: Record<string, string>, locale: Locale = 'ko'): string {
  const document = parseDocument(specYaml);
  if (document.errors.length) throw new Error(translate(locale, 'dag', 'parseError'));
  const defaults = (document.toJS() as { 'default-values'?: Record<string, unknown> })['default-values'] ?? {};
  document.set('default-values', { ...defaults, ...vars });
  return document.toString();
}
