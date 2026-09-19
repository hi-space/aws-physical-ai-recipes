'use client';
import * as React from 'react';
import Link from 'next/link';
import { Disclosure, CopyButton } from '@/components/ui';
import { useT } from '@/lib/i18n';

export type TechnicalDetailsRow = {
  label: string;
  value?: string | null;
  copy?: boolean;
  href?: string;
  mono?: boolean;
};

export interface TechnicalDetailsProps {
  rows: TechnicalDetailsRow[];
  title?: string;
  defaultOpen?: boolean;
  'data-testid'?: string;
}

/**
 * Disclosure-based container for raw technical identifiers (ARNs, IDs, pod names, image URIs).
 * Rows with an empty/null value are skipped; if no row has a value, nothing is rendered.
 * Non-empty rows render at 12px; pass `mono` for identifiers that read better in monospace.
 */
export function TechnicalDetails({
  rows,
  title,
  defaultOpen = false,
  'data-testid': testId,
}: TechnicalDetailsProps) {
  const tc = useT('common');
  const filtered = rows.filter((r) => r.value);

  if (filtered.length === 0) return null;

  return (
    <div data-technical-details="" data-testid={testId} className="space-y-2">
      <Disclosure
        title={title ?? tc('technicalDetails')}
        defaultOpen={defaultOpen}
        className="border-border-strong/50"
      >
        <dl className="space-y-2">
          {filtered.map((row, i) => (
            <div key={i} className="flex items-start gap-2">
              <dt className="min-w-max text-[13px] font-medium text-fg-muted">{row.label}</dt>
              <dd className={`flex min-w-0 items-center gap-1 break-all text-[12px] text-fg ${row.mono ? 'mono' : ''}`}>
                {row.href ? (
                  <Link href={row.href} target="_blank" className="text-accent hover:underline">
                    {row.value}
                  </Link>
                ) : (
                  row.value
                )}
                {row.copy && <CopyButton text={row.value!} />}
              </dd>
            </div>
          ))}
        </dl>
      </Disclosure>
    </div>
  );
}
