import { parseDocument } from 'yaml';

/** Preserve the submitted revision; recorded overrides must survive a new submission. */
export function cloneWorkflowYaml(specYaml: string, vars: Record<string, string>): string {
  const document = parseDocument(specYaml);
  if (document.errors.length) throw new Error('저장된 워크플로 YAML을 읽을 수 없습니다.');
  const defaults = (document.toJS() as { 'default-values'?: Record<string, unknown> })['default-values'] ?? {};
  document.set('default-values', { ...defaults, ...vars });
  return document.toString();
}
