'use client';
import * as React from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Database, Trash2 } from 'lucide-react';
import { useT } from '@/lib/i18n';
import type { PortKind } from '@/lib/workflow/ports';
import { handleCompatible } from './composer-state';
import { portColor, portKindLabel } from './ports-ui';
import { useDragEndpoint } from './use-drag-endpoint';

export interface DatasetSourceNodeData extends Record<string, unknown> {
  name: string;
  version: number;
  /** Derived output kind; undefined means unverified (connects to any input). */
  kind?: PortKind;
  selected: boolean;
  onDelete: (datasetId: string) => void;
}
export type DatasetFlowNode = Node<DatasetSourceNodeData, 'dataset'>;

/** The output handle id for a dataset source; edges reference it as their sourceHandle. */
export const DATASET_OUTPUT_HANDLE = 'dataset';

/**
 * A dataset source block bound to a registered dataset. Its output handle is coloured by the derived
 * kind (or the unverified `artifacts` colour when the dataset carries no `kind:` tag). An unverified
 * source connects to any input; a tagged one only to matching inputs (see connectionReason). While a
 * drag from an input handle is in progress the block lights up or fades by that same rule.
 */
export function DatasetSourceNode({ id, data, selected }: NodeProps<DatasetFlowNode>) {
  const t = useT('compose');
  const handleColor = portColor(data.kind ?? 'artifacts');
  const isSelected = selected || data.selected;
  const kindLabel = data.kind ? portKindLabel(data.kind, t) : t('unverifiedKind');
  const drag = useDragEndpoint();
  const state = !drag ? 'idle' : drag.nodeId === id ? 'origin' : handleCompatible(drag, { nodeId: id, type: 'source', kind: data.kind }) ? 'compatible' : 'incompatible';

  return (
    <div
      className={[
        'relative flex w-52 items-center gap-2 rounded-full border border-dashed bg-bg-elev px-3 py-2 shadow-sm transition-[border-color,box-shadow,opacity]',
        isSelected ? 'border-accent shadow-[0_0_0_3px_rgba(110,168,254,0.25)]' : 'border-border-strong',
        state === 'incompatible' ? 'opacity-40' : '',
      ].join(' ')}
      title={kindLabel}
      data-drag-dimmed={state === 'incompatible' || undefined}
    >
      <Database size={14} className="shrink-0" style={{ color: handleColor }} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-fg" title={data.name || t('datasetUnset')}>
          {data.name || t('datasetUnset')}
        </div>
        <div className="truncate text-[11px] text-fg-faint">
          {data.name ? `${t('datasetVersion', { version: data.version })} · ${kindLabel}` : kindLabel}
        </div>
      </div>
      <button
        type="button"
        className="rounded p-0.5 text-fg-faint hover:bg-bg-elev-2 hover:text-err"
        aria-label={t('deleteNode')}
        onClick={(e) => { e.stopPropagation(); data.onDelete(id); }}
      >
        <Trash2 size={14} />
      </button>
      <Handle
        type="source"
        position={Position.Right}
        id={DATASET_OUTPUT_HANDLE}
        style={{
          width: state === 'compatible' ? 14 : 10, height: state === 'compatible' ? 14 : 10, background: handleColor, borderColor: 'var(--color-bg)',
          transition: 'box-shadow 120ms, width 120ms, height 120ms',
          ...(state === 'compatible' ? { boxShadow: `0 0 0 4px ${handleColor}55, 0 0 12px ${handleColor}` } : {}),
        }}
        data-handle-state={state}
      />
    </div>
  );
}
