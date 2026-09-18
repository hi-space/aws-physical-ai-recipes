'use client';
import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LinkButton,
  Select,
  Spinner,
  Stat,
  Textarea,
  Toast,
} from '@/components/ui';
import { classNames as cx } from '@/lib/format';
import { api, can, useApi, useApiMutation, useMe } from '@/lib/api-client';
import { useT, useFormat } from '@/lib/i18n';

interface Dataset {
  name: string;
  description?: string;
  owner: string;
  tags: string[];
  latestVersion: number;
  createdAt: string;
  updatedAt: string;
  format?: string;
}

export function DatasetsPage() {
  const t = useT('datasets');
  const tc = useT('common');
  const { ago, fmtNum } = useFormat();
  const me = useMe();
  const [legacy, setLegacy] = React.useState(false);
  const { data, isLoading, error } = useApi<Dataset[]>(legacy ? '/api/datasets?legacy=1' : '/api/datasets', { refetch: 10000 });
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);
  const [search, setSearch] = React.useState('');
  const [createOpen, setCreateOpen] = React.useState(false);

  const createMutation = useApiMutation(
    async (input: { name: string; description?: string; tags?: string[]; format?: string }) =>
      api<Dataset>('/api/datasets', { method: 'POST', json: input }),
    ['/api/datasets']
  );

  const filtered = React.useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase();
    return data.filter((d) => d.name.toLowerCase().includes(q) || d.description?.toLowerCase().includes(q));
  }, [data, search]);

  const stats = React.useMemo(() => {
    if (!data) return { datasets: 0, versions: 0, produced: 0 };
    return {
      datasets: data.length,
      versions: data.reduce((a, b) => a + b.latestVersion, 0),
      produced: data.filter((d) => d.tags.includes('workflow-output')).length,
    };
  }, [data]);

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const tagsStr = form.get('tags') as string;
    try {
      await createMutation.mutateAsync({
        name: form.get('name') as string,
        description: form.get('description') as string,
        tags: tagsStr ? tagsStr.split(',').map((t) => t.trim()) : [],
        format: form.get('format') as string,
      });
      setToast({ message: t('toastCreated'), tone: 'ok' });
      setCreateOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : tc('errorGeneric');
      setToast({ message: msg, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label={legacy ? t('loadingLegacy') : t('loadingLegacy')} />;

  return (
    <>
      <label className="mb-3 flex items-center gap-2 text-xs text-fg-muted"><input type="checkbox" checked={legacy} onChange={(event) => setLegacy(event.target.checked)} />{t('showLegacy')}</label>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="space-y-4">
        {error && <ErrorBox error={error} />}

        {/* Stats */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label={t('statDatasets')} value={fmtNum(stats.datasets)} />
          <Stat label={t('statVersions')} value={fmtNum(stats.versions)} />
          <Stat label={t('statProduced')} value={fmtNum(stats.produced)} />
        </div>

        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <Input placeholder={t('searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} className="flex-1" />
          <div className="flex gap-2">
            {can(me.data, 'researcher') && (
              <Dialog
                open={createOpen}
                onClose={() => setCreateOpen(false)}
                title={t('createTitle')}
              >
                <form onSubmit={handleCreate} className="space-y-4">
                  <Field label={t('createName')} help={t('createNameHelp')}>
                    <Input name="name" placeholder={t('createNamePlaceholder')} required pattern="^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" maxLength={60} />
                  </Field>
                  <Field label={t('createDesc')}>
                    <Textarea name="description" placeholder={t('createDescPlaceholder')} maxLength={500} rows={3} />
                  </Field>
                  <Field label={t('createTags')} help={t('createTagsHelp')}>
                    <Input name="tags" placeholder={t('createTagsPlaceholder')} />
                  </Field>
                  <Field label={t('createFormat')}>
                    <Select name="format" defaultValue="">
                      <option value="">{t('createFormatNone')}</option>
                      <option value="lerobot-v2.1">lerobot-v2.1</option>
                      <option value="lerobot-v3">lerobot-v3</option>
                      <option value="rsl-rl-checkpoint">rsl-rl-checkpoint</option>
                      <option value="sb3-checkpoint">sb3-checkpoint</option>
                      <option value="other">other</option>
                    </Select>
                  </Field>
                  <div className="flex gap-2 justify-end">
                    <Button type="button" onClick={() => setCreateOpen(false)} variant="ghost">
                      {tc('cancel')}
                    </Button>
                    <Button type="submit" loading={createMutation.isPending}>
                      {tc('create')}
                    </Button>
                  </div>
                </form>
              </Dialog>
            )}
            {can(me.data, 'researcher') && (
              <Button onClick={() => setCreateOpen(true)}>
                {t('newDataset')}
              </Button>
            )}
            <LinkButton href="/workflows/new?template=hf-dataset-import">{t('importHF')}</LinkButton>
          </div>
        </div>

        {/* Table */}
        {filtered.length === 0 ? (
          <EmptyState title={data?.length === 0 ? t('empty') : t('noMatches')} />
        ) : (
          <Card padded={false}>
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <th className="py-2 px-3 text-left text-xs font-semibold">{t('colName')}</th>
                  <th className="py-2 px-3 text-left text-xs font-semibold">{t('colDesc')}</th>
                  <th className="py-2 px-3 text-left text-xs font-semibold">{t('colLatest')}</th>
                  <th className="py-2 px-3 text-left text-xs font-semibold">{t('colTags')}</th>
                  <th className="py-2 px-3 text-left text-xs font-semibold">{tc('owner')}</th>
                  <th className="py-2 px-3 text-left text-xs font-semibold">{tc('updated')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.name} className="border-b border-border hover:bg-bg-elev-1 transition">
                    <td className="py-2 px-3">
                      <Link href={`/datasets/${d.name}`} className="text-accent hover:underline font-mono text-sm">
                        {d.name}
                      </Link>
                    </td>
                    <td className="py-2 px-3 text-xs">
                      {d.description ? d.description.slice(0, 50) + (d.description.length > 50 ? '…' : '') : '—'}
                    </td>
                    <td className="py-2 px-3 mono text-sm">v{d.latestVersion}</td>
                    <td className="py-2 px-3">
                      <div className="flex gap-1 flex-wrap">
                        {d.tags.map((tag) => (
                          <Badge key={tag}>{tag}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-xs">{d.owner}</td>
                    <td className="py-2 px-3 text-xs text-fg-muted">{ago(d.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
