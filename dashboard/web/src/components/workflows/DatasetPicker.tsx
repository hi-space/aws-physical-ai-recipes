'use client';
import { useEffect, useMemo, useRef } from 'react';
import { EmptyState, ErrorBox, Field, LinkButton, Select, Spinner } from '@/components/ui';
import { useFormat, useT } from '@/lib/i18n';
import { useApi } from '@/lib/api-client';
import type { Dataset, DatasetVersion } from '@/server/store/types';
import type { PortKind } from '@/lib/workflow/ports';

export interface DatasetPickerProps {
  value: string;
  version: string | undefined;
  onChange(name: string, version?: number): void;
  kind?: PortKind;
  disabled?: boolean;
}

interface DatasetDetail {
  dataset: Dataset;
  versions: DatasetVersion[];
}

export function DatasetPicker({ value, version, onChange, kind, disabled }: DatasetPickerProps) {
  const t = useT('newWorkflow');
  const tc = useT('common');
  const { fmtTime } = useFormat();
  const { data: datasets, isLoading: datasetsLoading, error: datasetsError } = useApi<Dataset[]>('/api/datasets');
  const { data: detail, isLoading: versionsLoading, error: versionsError } = useApi<DatasetDetail>(
    value ? `/api/datasets/${encodeURIComponent(value)}` : null
  );

  // Preference only, never a hard filter: a dataset explicitly tagged `kind:<PortKind>` by its
  // producer (see outputKindTag in server/workflow/artifacts.ts) sorts first. This relies solely on
  // a recorded fact rather than guessing a mapping from `format` or name to a port kind.
  const sortedDatasets = useMemo(() => {
    if (!datasets) return [];
    if (!kind) return datasets;
    const tag = `kind:${kind}`;
    return [...datasets].sort((a, b) => Number(b.tags.includes(tag)) - Number(a.tags.includes(tag)));
  }, [datasets, kind]);

  const readyVersions = useMemo(() => {
    if (!detail) return [];
    return detail.versions.filter((v) => v.state === 'READY').sort((a, b) => b.version - a.version);
  }, [detail]);

  // Deep-link / fresh-selection convenience: once a dataset with READY versions is selected and no
  // version is set, default to the latest READY version. Guarding on `version` alone isn't enough:
  // when the caller's param has no slot to persist the version (see TemplateParamField's `dataset`
  // case), `version` never becomes truthy, and `onChange` is a fresh arrow every render, so the
  // effect would refire on every parent re-render and loop forever ("maximum update depth
  // exceeded"). Track the last dataset we auto-selected a version for in a ref so this fires at
  // most once per dataset selection, independent of `onChange`'s identity or whether the version
  // ever round-trips back into `version`.
  const autoSelectedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!value) {
      autoSelectedFor.current = undefined;
      return;
    }
    if (!version && readyVersions.length > 0 && autoSelectedFor.current !== value) {
      autoSelectedFor.current = value;
      onChange(value, readyVersions[0].version);
    }
  }, [value, version, readyVersions, onChange]);

  if (datasetsLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <Spinner /> {t('datasetLoading')}
      </div>
    );
  }

  if (datasetsError) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-err">{t('datasetsLoadError')}</div>
        <ErrorBox error={datasetsError} />
      </div>
    );
  }

  if (!datasets || datasets.length === 0) {
    return (
      <EmptyState
        title={t('noDatasets')}
        hint={t('datasetEmptyHelp')}
        action={
          <LinkButton href="/workflows/new?template=hf-dataset-import" variant="primary">
            {t('datasetsPageLink')}
          </LinkButton>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <Field label={t('paramDatasetName')}>
        <Select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value, undefined)}
        >
          <option value="">{tc('select')}</option>
          {sortedDatasets.map((d) => (
            <option key={d.name} value={d.name}>
              {`${d.name} · v${d.latestVersion} · ${fmtTime(d.updatedAt)}`}
            </option>
          ))}
        </Select>
      </Field>
      {value && (
        <>
          {versionsLoading && <Spinner label={t('datasetLoading')} />}
          {versionsError && (
            <div className="space-y-2">
              <div className="text-sm text-err">{t('datasetVersionsLoadError')}</div>
              <ErrorBox error={versionsError} />
            </div>
          )}
          {!versionsLoading && !versionsError && readyVersions.length > 0 && (
            <Field label={t('datasetVersion')}>
              <Select
                value={version ?? ''}
                disabled={disabled}
                onChange={(e) => onChange(value, e.target.value ? Number(e.target.value) : undefined)}
              >
                <option value="">{tc('select')}</option>
                {readyVersions.map((v) => (
                  <option key={v.version} value={v.version}>{`v${v.version}`}</option>
                ))}
              </Select>
            </Field>
          )}
        </>
      )}
    </div>
  );
}
