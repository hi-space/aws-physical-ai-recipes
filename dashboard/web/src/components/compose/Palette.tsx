'use client';
import * as React from 'react';
import { Database } from 'lucide-react';
import { Badge } from '@/components/ui';
import { useT } from '@/lib/i18n';
import type { Template } from '@/server/store/types';
import type { TemplateDto } from '@/lib/workflow/template-dto';
import type { PortKind, RecipePorts } from '@/lib/workflow/ports';
import { portColor, portKindLabel } from './ports-ui';

/** Payload carried by a palette drag; ComposePage reads it in onDrop to place a node. */
export type PaletteDrag = { kind: 'template'; templateId: string; title: string } | { kind: 'dataset' };
export const PALETTE_MIME = 'application/pai-compose';

export interface PaletteProps {
  templates: TemplateDto[];
  onAddTemplate: (template: TemplateDto) => void;
  onAddDataset: () => void;
}

const CATEGORY_ORDER: Template['category'][] = ['data', 'training', 'evaluation', 'simulation', 'setup', 'custom'];

const uniqueKinds = (kinds: PortKind[]): PortKind[] => [...new Set(kinds)];

/** One kind chip: coloured dot + kind label. */
function KindChip({ kind }: { kind: PortKind }) {
  const t = useT('compose');
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: portColor(kind) }} aria-hidden />
      {portKindLabel(kind, t)}
    </span>
  );
}

/**
 * What a block takes in and gives out, as kind chips — the same colours as the canvas handles. Blocks
 * with no inputs are labelled as pipeline starts so users know they go first.
 */
function PortSummary({ ports }: { ports: RecipePorts }) {
  const t = useT('compose');
  const inputs = uniqueKinds(ports.inputs.map((p) => p.kind));
  const outputs = uniqueKinds(ports.outputs.map((p) => p.kind));
  return (
    <dl className="mt-1.5 space-y-0.5 text-[11px] text-fg-faint" data-testid="palette-ports">
      <div className="flex flex-wrap items-center gap-x-1.5">
        <dt className="shrink-0 after:content-[':']">{t('paletteInputs')}</dt>
        {inputs.length === 0 ? <dd>{t('paletteNoInputs')}</dd> : inputs.map((k) => <dd key={k}><KindChip kind={k} /></dd>)}
      </div>
      {outputs.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-1.5">
          <dt className="shrink-0 after:content-[':']">{t('paletteOutputs')}</dt>
          {outputs.map((k) => <dd key={k}><KindChip kind={k} /></dd>)}
        </div>
      )}
    </dl>
  );
}

export function Palette({ templates, onAddTemplate, onAddDataset }: PaletteProps) {
  const t = useT('compose');
  const tn = useT('newWorkflow');
  const categoryLabel: Record<Template['category'], string> = {
    setup: tn('categorySetup'), data: tn('categoryData'), training: tn('categoryTraining'),
    evaluation: tn('categoryEvaluation'), simulation: tn('categorySimulation'), custom: tn('categoryCustom'),
  };

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    items: templates.filter((tpl) => tpl.category === category),
  })).filter((group) => group.items.length > 0);

  const setDrag = (e: React.DragEvent, payload: PaletteDrag) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(PALETTE_MIME, JSON.stringify(payload));
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-elev">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-fg">{t('palette')}</h2>
        <p className="mt-0.5 text-[12px] text-fg-muted">{t('paletteHint')}</p>
      </div>

      <div className="p-3">
        <button
          type="button"
          draggable
          onDragStart={(e) => setDrag(e, { kind: 'dataset' })}
          onClick={onAddDataset}
          className="flex w-full cursor-grab items-start gap-2 rounded-md border border-dashed border-border-strong bg-bg-elev-2 px-3 py-2 text-left transition-colors hover:border-accent active:cursor-grabbing"
        >
          <Database size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-fg">{t('datasetSource')}</span>
            <span className="block text-[12px] text-fg-muted">{t('datasetSourceHint')}</span>
          </span>
        </button>
      </div>

      {grouped.map((group) => (
        <div key={group.category} className="px-3 pb-3">
          <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{categoryLabel[group.category]}</h3>
          <div className="space-y-1.5">
            {group.items.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                draggable
                onDragStart={(e) => setDrag(e, { kind: 'template', templateId: tpl.id, title: tpl.title })}
                onClick={() => onAddTemplate(tpl)}
                data-testid={`palette-item-${tpl.id}`}
                className="w-full cursor-grab rounded-md border border-border bg-bg-elev-2 px-3 py-2 text-left transition-colors hover:border-accent active:cursor-grabbing"
              >
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg" title={tpl.title}>{tpl.title}</span>
                  {tpl.requires?.includes('gpu') && <Badge tone="warn">{t('gpuBadge')}</Badge>}
                </div>
                {tpl.description && <div className="mt-0.5 line-clamp-2 text-[12px] text-fg-muted">{tpl.description}</div>}
                {tpl.recipe?.ports && <PortSummary ports={tpl.recipe.ports} />}
              </button>
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
}
