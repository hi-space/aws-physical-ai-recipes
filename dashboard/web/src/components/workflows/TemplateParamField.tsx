'use client';
import { Field, Input, Select, Textarea } from '@/components/ui';
import { useT } from '@/lib/i18n';
import type { TemplateParam } from '@/server/store/types';
import { DatasetPicker } from './DatasetPicker';
import type { PortKind } from '@/lib/workflow/ports';

export interface TemplateParamFieldProps {
  param: TemplateParam;
  value: string;
  values: Record<string, string>;
  locked?: boolean;
  kind?: PortKind;
  disabled?: boolean;
  onChange(name: string, value: string): void;
}

export function TemplateParamField({ param, value, values, locked, kind, disabled, onChange }: TemplateParamFieldProps) {
  const t = useT('newWorkflow');

  if (locked) {
    return (
      <Field label={param.label} help={t('locked')}>
        {param.type === 'text'
          ? <Textarea value={value} readOnly />
          : <Input type={param.type === 'number' ? 'number' : 'text'} value={value} readOnly />}
      </Field>
    );
  }

  switch (param.type) {
    case 'string':
      return (
        <Field label={param.label} help={param.help}>
          <Input value={value} disabled={disabled} onChange={e => onChange(param.name, e.target.value)} />
        </Field>
      );
    case 'number':
      return (
        <Field label={param.label} help={param.help}>
          <Input type="number" step="any" value={value} disabled={disabled} onChange={e => onChange(param.name, e.target.value)} />
        </Field>
      );
    case 'text':
      return (
        <Field label={param.label} help={param.help}>
          <Textarea value={value} disabled={disabled} onChange={e => onChange(param.name, e.target.value)} />
        </Field>
      );
    case 'boolean':
      return (
        <Field label={param.label} help={param.help}>
          <input type="checkbox" checked={value === 'true'} disabled={disabled} onChange={e => onChange(param.name, e.target.checked ? 'true' : 'false')} />
        </Field>
      );
    case 'select':
      return (
        <Field label={param.label} help={param.help}>
          <Select value={value} disabled={disabled} onChange={e => onChange(param.name, e.target.value)}>
            {param.options?.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </Select>
        </Field>
      );
    case 'dataset':
      // Only echo the version back into `values` when the param declares a `versionParam` slot to
      // hold it. Without one there is nowhere to persist the version, so wiring it back into
      // `onChange` would hand DatasetPicker's auto-select effect a `version` that never actually
      // becomes non-empty — re-firing `onChange` every render and looping. Treat the version select
      // as informational-only in that case (still shown, just not round-tripped).
      return (
        <DatasetPicker
          value={value}
          version={param.versionParam ? values[param.versionParam] : undefined}
          disabled={disabled}
          onChange={(name, version) => {
            onChange(param.name, name);
            if (param.versionParam && version !== undefined) {
              onChange(param.versionParam, String(version));
            }
          }}
          kind={kind}
        />
      );
    default:
      return null;
  }
}
