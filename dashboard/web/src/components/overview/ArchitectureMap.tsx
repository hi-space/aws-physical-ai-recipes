'use client';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Badge, Card, ErrorBox, Spinner, StatusPill } from '@/components/ui';
import { useApi, useMe } from '@/lib/api-client';
import { useFormat, useT } from '@/lib/i18n';
import { consoleUrl } from '@/lib/console-links';
import type { ArchComponent, ArchitectureResponse, LayerId } from '@/server/services/architecture';

const LAYERS: LayerId[] = ['data', 'compute', 'training', 'simulation', 'edge', 'platform'];

/**
 * The deployed AWS architecture, one column per layer. Each tile shows the AWS service, the resource identifier and,
 * when the dashboard has a permitted Describe call, the raw status that call returned. Identifier-only resources are
 * marked as such instead of being painted green.
 */
export function ArchitectureMap() {
  const t = useT('overview');
  const { ago, fmtNum, fmtTime } = useFormat();
  const me = useMe();
  const { data, isLoading, error } = useApi<ArchitectureResponse>('/api/architecture', { refetch: 60_000 });
  const region = data?.region ?? me.data?.region;

  const fact = (key: ArchComponent['facts'] extends Array<infer F> | undefined ? (F extends { key: infer K } ? K : never) : never, value: string | number) => {
    switch (key) {
      case 'instanceGroups': return t('factInstanceGroups', { count: fmtNum(Number(value)) });
      case 'nodeRecovery': return t('factNodeRecovery', { value: String(value) });
      case 'eksVersion': return t('factEksVersion', { value: String(value) });
      case 'capacityGiB': return t('factCapacityGiB', { value: fmtNum(Number(value)) });
      case 'dataRepositories': return t('factDataRepositories', { count: fmtNum(Number(value)) });
      case 'clusterQueues': return t('factClusterQueues', { count: fmtNum(Number(value)) });
      case 'instanceType': return String(value);
      case 'members': return t('factMembers', { count: fmtNum(Number(value)) });
      case 'lastModified': return t('factLastModified', { time: fmtTime(String(value)) });
      case 'orchestrator': return t('factOrchestrator', { value: String(value) });
      default: return String(value);
    }
  };

  const body = () => {
    if (isLoading && !data) return <Spinner label={t('architectureLoading')} />;
    if (!data) return <ErrorBox error={error ?? new Error(t('noData'))} />;
    const byLayer = LAYERS.map((layer) => ({ layer, components: data.components.filter((component) => component.layer === layer) })).filter((group) => group.components.length);
    return (
      <>
        {error && <p className="mb-3 text-xs text-fg-muted">{t('architectureStale')}</p>}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {byLayer.map(({ layer, components }) => (
            <section key={layer} aria-label={t(`layer_${layer}`)} className="space-y-2">
              <div>
                <h4 className="text-[13px] font-semibold text-fg">{t(`layer_${layer}`)}</h4>
                <p className="text-[11px] leading-snug text-fg-muted">{t(`layerDesc_${layer}`)}</p>
              </div>
              {components.map((component) => {
                const href = component.console && region ? consoleUrl(component.console, region) : undefined;
                return (
                  <div key={component.id} className="space-y-1.5 rounded-md border border-border bg-bg-elev-2 p-2.5 text-[13px]">
                    <div className="text-[11px] text-fg-muted">{component.service}</div>
                    <div className="flex items-center gap-1.5">
                      {component.href ? <Link href={component.href} className="mono min-w-0 truncate font-medium text-accent hover:underline" title={component.resource}>{component.resource}</Link> : <span className="mono min-w-0 truncate font-medium text-fg" title={component.resource}>{component.resource}</span>}
                      {href && <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-fg-faint hover:text-accent" title={t('openConsole')} aria-label={`${t('openConsole')}: ${component.resource}`}><ExternalLink size={12} /></a>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      {component.status && <StatusPill status={component.status} />}
                      {component.evidence === 'config' && <Badge tone="neutral" className="text-[11px]">{t('evidenceConfig')}</Badge>}
                      {component.evidence === 'describe' && !component.status && !component.error && <Badge tone="ok" className="text-[11px]">{t('evidenceReachable')}</Badge>}
                      {component.facts?.map((f) => <span key={f.key} className="text-fg-muted">{fact(f.key, f.value)}</span>)}
                    </div>
                    {component.api && <div className="text-[11px] text-fg-faint">{component.api}</div>}
                    {component.error && <ErrorBox error={{ message: component.error }} />}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
        <p className="mt-4 text-xs text-fg-faint">{t('architectureFooter', { time: ago(data.fetchedAt), region: data.region, account: data.accountId })}</p>
      </>
    );
  };

  return <Card title={t('architecture')} description={t('architectureDesc')}>{body()}</Card>;
}
