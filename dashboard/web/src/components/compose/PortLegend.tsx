'use client';
import * as React from 'react';
import { useT } from '@/lib/i18n';
import { PORT_KINDS } from '@/lib/workflow/ports';
import { portColor, portKindLabel } from './ports-ui';

/** Colour → kind legend shown on the canvas so a user can tell which ports connect before dragging. */
export function PortLegend() {
  const t = useT('compose');
  return (
    <div className="rounded-md border border-border bg-bg-elev/90 px-3 py-2 text-[11px] shadow-sm backdrop-blur" data-testid="port-legend">
      <div className="mb-1 font-semibold text-fg">{t('legendTitle')}</div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {PORT_KINDS.map((kind) => (
          <li key={kind} className="flex items-center gap-1.5 text-fg-muted">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: portColor(kind) }} aria-hidden />
            {portKindLabel(kind, t)}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 max-w-[240px] text-fg-faint">{t('legendHint')}</p>
    </div>
  );
}
