'use client';
import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { CopyButton } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { consoleUrl, type ConsoleResource } from '@/lib/console-links';
import { useApi, type Me } from '@/lib/api-client';

export interface ResourceItem {
  /** Label from the `resources` catalog (or already-translated text). */
  label: string;
  /** Identifier shown verbatim (cluster name, bucket, ARN…). Undefined renders "not configured". */
  value?: string;
  /** Console deep link target; omitted when no verified link shape exists for the resource. */
  console?: ConsoleResource;
  /** Internal dashboard route that manages the resource. */
  href?: string;
}

/**
 * Compact row under a page header naming the AWS resources the page reads and the API that produced the data.
 * Values come from the deployment contract or a live Describe call — never typed into the UI.
 */
export function ResourceStrip({ items, source, className }: { items: ResourceItem[]; source?: string; className?: string }) {
  const t = useT('resources');
  // useApi rather than useMe so page tests that stub only `useApi` keep working; same query key, same cache entry.
  const me = useApi<Me>('/api/me', { staleTime: 60_000 });
  const region = me.data?.region;
  const shown = items.filter((item) => item.value !== undefined);
  if (!shown.length && !source) return null;
  return (
    <div className={`mb-5 rounded-md border border-border bg-bg-elev px-3 py-2 text-xs ${className ?? ''}`} aria-label={t('stripTitle')}>
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {shown.map((item) => {
          const url = item.console && region ? consoleUrl(item.console, region) : undefined;
          return (
            <div key={`${item.label}:${item.value}`} className="flex min-w-0 items-center gap-1.5">
              <dt className="shrink-0 text-fg-faint">{item.label}</dt>
              <dd className="flex min-w-0 items-center gap-1">
                {item.href ? <a href={item.href} className="mono truncate text-accent hover:underline" title={item.value}>{item.value}</a> : <span className="mono truncate text-fg" title={item.value}>{item.value}</span>}
                <CopyButton text={item.value!} className="opacity-60 hover:opacity-100" />
                {url && <a href={url} target="_blank" rel="noreferrer" aria-label={`${t('openConsole')}: ${item.label}`} title={t('openConsole')} className="text-fg-faint hover:text-accent"><ExternalLink size={12} /></a>}
              </dd>
            </div>
          );
        })}
      </dl>
      {source && <div className="mt-1 text-fg-faint"><span className="text-fg-muted">{t('source')}:</span> {source}</div>}
    </div>
  );
}
