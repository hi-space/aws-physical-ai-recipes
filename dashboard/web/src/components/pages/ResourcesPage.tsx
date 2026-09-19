'use client';
import * as React from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, Disclosure, EmptyState, ErrorBox, Input, Spinner, StatusPill, Table } from '@/components/ui';
import { useApi } from '@/lib/api-client';
import { useFormat, useT } from '@/lib/i18n';
import type { ResourcesResponse, TaggedResource } from '@/server/aws/tagged-resources';

type Group = ResourcesResponse['groups'][number];

export function filterGroups(groups: Group[], query: string): Group[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => [i.name, i.type, i.arn].some((v) => v.toLowerCase().includes(q))) }))
    .filter((g) => g.items.length);
}

function Details({ item, t }: { item: TaggedResource; t: ReturnType<typeof useT<'resourcesPage'>> }) {
  const d = item.details ?? {};
  const pairs: [string, string | number | undefined][] = [
    [t('state'), d.state],
    [t('instanceType'), d.instanceType],
    [t('privateIp'), d.privateIp],
    [t('az'), d.az],
  ];
  return <span className="text-xs text-fg-muted">{pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${v}`).join(' · ')}</span>;
}

export function ResourcesPage() {
  const t = useT('resourcesPage');
  const tc = useT('common');
  const { ago } = useFormat();
  const [query, setQuery] = React.useState('');
  const { data, isLoading, error, refetch, isFetching } = useApi<ResourcesResponse>('/api/resources', { refetch: 60_000 });
  const groups = React.useMemo(() => filterGroups(data?.groups ?? [], query), [data, query]);
  const total = data?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0;

  return (
    <div>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button size="sm" variant="ghost" onClick={() => void refetch()} loading={isFetching}>
            {t('refresh')}
          </Button>
        }
      >
        {data && (
          <p className="mt-1 text-xs text-fg-muted">
            {t('tag')}: <code>{data.tag.key}={data.tag.value}</code> · {t('fetchedAt')}: {ago(data.fetchedAt)} · {t('count', { n: total })}
          </p>
        )}
      </PageHeader>
      <div className="mb-3">
        <Input aria-label={t('search')} placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {error && <ErrorBox error={error} />}
      {isLoading && !data && <Spinner label={tc('loading')} />}
      {data && !data.groups.length && <EmptyState title={t('empty')} hint={t('emptyHint')} />}
      <div className="space-y-3">
        {groups.map((group) => (
          <Card key={group.service} padded={false}>
            <Disclosure
              title={
                <span className="flex items-center gap-2">
                  {group.service}
                  <Badge tone="neutral">{t('count', { n: group.items.length })}</Badge>
                </span>
              }
              defaultOpen={group.service === 'EC2'}
            >
              {group.error && (
                <p role="alert" className="px-3 pb-2 text-xs text-warning">
                  {t('groupError', { message: group.error })}
                </p>
              )}
              <Table dense head={[t('colName'), t('colType'), t('colRegion'), t('colDetails'), t('colConsole')]}>
                {group.items.map((item) => (
                  <tr key={item.arn}>
                    <td className="font-medium" title={item.arn}>
                      {item.name}
                    </td>
                    <td>{item.type}</td>
                    <td>{item.region}</td>
                    <td>
                      {item.details?.state ? (
                        <span className="flex items-center gap-2">
                          <StatusPill status={String(item.details.state)} />
                          <Details item={item} t={t} />
                        </span>
                      ) : (
                        <Details item={item} t={t} />
                      )}
                    </td>
                    <td>
                      {item.consoleUrl ? (
                        <a className="text-accent underline" href={item.consoleUrl} target="_blank" rel="noreferrer">
                          {t('open')}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </Table>
            </Disclosure>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-fg-faint">{t('source')}</p>
    </div>
  );
}
