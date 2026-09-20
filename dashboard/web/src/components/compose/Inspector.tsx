'use client';
import * as React from 'react';
import { Field } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useApi } from '@/lib/api-client';
import { TemplateParamField } from '@/components/workflows/TemplateParamField';
import { DatasetPicker } from '@/components/workflows/DatasetPicker';
import type { Dataset } from '@/server/store/types';
import type { PortKind } from '@/lib/workflow/ports';
import type { TemplateDto } from '@/lib/workflow/template-dto';
import type { DatasetNodeDef, NodeDef } from './composer-state';
import { datasetKindFromTags, portKindLabel } from './ports-ui';

export interface InspectorProps {
  node?: NodeDef;
  template?: TemplateDto;
  dataset?: DatasetNodeDef;
  /** The selected recipe node's param values, keyed by unprefixed param name. */
  values: Record<string, string>;
  /** paramName → the label of whatever edge feeds it; presence means the param is edge-bound. */
  bindings: Record<string, string>;
  onSetParam: (paramName: string, value: string) => void;
  onRenameNode: (newTitle: string) => void;
  onSetDataset: (name: string, version: number, kind?: PortKind) => void;
}

/** Uncontrolled title editor, remounted per node via `key` so it always starts from the node's title. */
function TitleEditor({ title, onRename, label }: { title: string; onRename: (next: string) => void; label: string }) {
  const [value, setValue] = React.useState(title);
  const commit = () => {
    const next = value.trim();
    if (next && next !== title) onRename(next);
    else setValue(title);
  };
  return (
    <input
      aria-label={label}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold text-fg hover:border-border focus:border-accent focus:bg-bg focus:outline-none"
    />
  );
}

/** Binds a dataset source node to a registered dataset and derives its output kind from tags. */
function DatasetInspector({ dataset, onSetDataset }: { dataset: DatasetNodeDef; onSetDataset: InspectorProps['onSetDataset'] }) {
  const t = useT('compose');
  const { data: datasets } = useApi<Dataset[]>('/api/datasets');
  const kindOf = (name: string) => datasetKindFromTags(datasets?.find((d) => d.name === name)?.tags);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-border px-3 py-3">
        <div className="px-2 text-base font-semibold text-fg">{t('datasetSource')}</div>
      </div>
      <div className="space-y-3 p-3">
        <DatasetPicker
          value={dataset.name}
          version={dataset.version > 0 ? String(dataset.version) : undefined}
          onChange={(name, version) => onSetDataset(name, version ?? 0, kindOf(name))}
        />
        {dataset.name && (
          <Field label={t('outputKind')} help={dataset.kind ? undefined : t('unverifiedKind')}>
            <div className="flex h-9 items-center rounded-md border border-border-strong bg-bg-elev-2 px-3 text-sm text-fg">
              {dataset.kind ? portKindLabel(dataset.kind, t) : portKindLabel('artifacts', t)}
            </div>
          </Field>
        )}
      </div>
    </div>
  );
}

export function Inspector({ node, template, dataset, values, bindings, onSetParam, onRenameNode, onSetDataset }: InspectorProps) {
  const t = useT('compose');

  if (dataset) return <DatasetInspector dataset={dataset} onSetDataset={onSetDataset} />;

  if (!node || !template) {
    return <div className="p-4 text-[13px] text-fg-muted">{t('inspectorEmpty')}</div>;
  }

  const portKindOf = (paramName: string) => template.recipe?.ports?.inputs.find((p) => p.param === paramName)?.kind;
  // A dataset param's version is chosen inside its DatasetPicker (latest READY by default), so the raw
  // `dataset_version` number field is hidden here — the same rule the run wizard applies.
  const versionParams = new Set((template.params ?? []).flatMap((p) => (p.type === 'dataset' && p.versionParam ? [p.versionParam] : [])));
  const visibleParams = (template.params ?? []).filter((p) => !versionParams.has(p.name));

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-border px-3 py-3">
        <TitleEditor key={node.id} title={node.title} onRename={onRenameNode} label={t('titleLabel')} />
        <div className="mt-1 px-2 text-[12px] text-fg-faint">{template.title}</div>
      </div>

      <div className="space-y-3 p-3">
        <h3 className="text-[13px] font-semibold text-fg">{t('parameters')}</h3>
        {visibleParams.map((param) => {
          const boundLabel = bindings[param.name];
          if (boundLabel !== undefined) {
            return (
              <Field key={param.name} label={param.label} help={t('boundHelp')}>
                <div className="flex h-9 items-center rounded-md border border-border-strong bg-bg-elev-2 px-3 text-sm text-fg-muted">{boundLabel}</div>
              </Field>
            );
          }
          return (
            <TemplateParamField
              key={param.name}
              param={param}
              value={values[param.name] ?? param.default ?? ''}
              values={values}
              kind={portKindOf(param.name)}
              onChange={onSetParam}
            />
          );
        })}
        {visibleParams.length === 0 && <p className="text-[12px] text-fg-faint">—</p>}
      </div>
    </div>
  );
}
