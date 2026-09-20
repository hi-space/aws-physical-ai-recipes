'use client';
import * as React from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { useT, type Translator } from '@/lib/i18n';
import type { RecipeMetadata } from '@/lib/workflow/recipe-metadata';
import type { PortKind } from '@/lib/workflow/ports';
import { handleCompatible, type HandleEndpoint } from './composer-state';
import { portColor, portKindLabel } from './ports-ui';
import { useDragEndpoint } from './use-drag-endpoint';

export interface RecipeNodeData extends Record<string, unknown> {
  title: string;
  category: string;
  recipe?: RecipeMetadata | null;
  /** Input params already fed by an edge; their handles cannot take another connection. */
  boundParams?: string[];
  selected: boolean;
  onDelete: (nodeId: string) => void;
}
export type RecipeFlowNode = Node<RecipeNodeData, 'recipe'>;

// Handles start below the title/pill block and step down evenly. Each port row shows its label and,
// underneath, its kind — so the row is two lines tall. The node height is derived from the larger of
// the input/output counts so every handle has room (see recipeNodeHeight below).
const HANDLE_TOP = 60;
const HANDLE_GAP = 34;
export const RECIPE_NODE_WIDTH = 224;

export function recipeNodeHeight(recipe?: RecipeMetadata | null): number {
  const rows = Math.max(recipe?.ports?.inputs.length ?? 0, recipe?.ports?.outputs.length ?? 0, 1);
  return HANDLE_TOP + rows * HANDLE_GAP;
}

/** Handle styling for one port while a drag is (or is not) in progress. */
export type HandleState = 'idle' | 'compatible' | 'incompatible' | 'origin';

export function handleState(drag: HandleEndpoint | null, self: HandleEndpoint): HandleState {
  if (!drag) return 'idle';
  if (drag.nodeId === self.nodeId) return 'origin';
  return handleCompatible(drag, self) ? 'compatible' : 'incompatible';
}

function handleStyle(kind: PortKind, state: HandleState): React.CSSProperties {
  const color = portColor(kind);
  const base: React.CSSProperties = { width: 10, height: 10, background: color, borderColor: 'var(--color-bg)', transition: 'opacity 120ms, box-shadow 120ms, transform 120ms' };
  if (state === 'compatible') return { ...base, width: 14, height: 14, boxShadow: `0 0 0 4px ${color}55, 0 0 12px ${color}` };
  if (state === 'incompatible') return { ...base, opacity: 0.2 };
  return base;
}

/** A recipe block: title, category pill, and typed input/output handles coloured and labelled by PortKind. */
export function RecipeNode({ id, data, selected }: NodeProps<RecipeFlowNode>) {
  const t = useT('compose');
  const inputs = data.recipe?.ports?.inputs ?? [];
  const outputs = data.recipe?.ports?.outputs ?? [];
  const isSelected = selected || data.selected;
  const drag = useDragEndpoint();
  const bound = new Set(data.boundParams ?? []);

  const inputStates = inputs.map((input) => handleState(drag, { nodeId: id, type: 'target', kind: input.kind, bound: bound.has(input.param) }));
  const outputStates = outputs.map((output) => handleState(drag, { nodeId: id, type: 'source', kind: output.kind }));
  // A node with no handle that could complete the drag fades back so the candidates stand out.
  const dimmed = drag !== null && drag.nodeId !== id && ![...inputStates, ...outputStates].includes('compatible');

  return (
    <div
      className={[
        'relative rounded-lg border bg-bg-elev shadow-sm transition-[border-color,box-shadow,opacity]',
        isSelected ? 'border-accent shadow-[0_0_0_3px_rgba(110,168,254,0.25)]' : 'border-border hover:border-border-strong',
        dimmed ? 'opacity-40' : '',
      ].join(' ')}
      style={{ width: RECIPE_NODE_WIDTH, minHeight: recipeNodeHeight(data.recipe) }}
      data-drag-dimmed={dimmed || undefined}
    >
      <div className="px-3 pt-2.5 pb-1">
        <div className="truncate pr-6 text-sm font-semibold text-fg" title={data.title}>{data.title}</div>
        <span className="mt-1 inline-block rounded bg-bg-elev-2 px-1.5 py-0.5 text-[11px] text-fg-muted">{data.category}</span>
      </div>

      <button
        type="button"
        className="absolute right-1.5 top-1.5 rounded p-0.5 text-fg-faint hover:bg-bg-elev-2 hover:text-err"
        aria-label={t('deleteNode')}
        onClick={(e) => { e.stopPropagation(); data.onDelete(id); }}
      >
        <Trash2 size={14} />
      </button>

      {inputs.map((input, i) => {
        const state = inputStates[i];
        const top = HANDLE_TOP + i * HANDLE_GAP;
        return (
          <React.Fragment key={`in-${input.param}`}>
            <Handle
              type="target"
              position={Position.Left}
              id={input.param}
              style={{ top, ...handleStyle(input.kind, state) }}
              title={`${input.label} · ${portKindLabel(input.kind, t)}`}
              data-handle-state={state}
            />
            <PortLabel side="left" top={top} label={input.label} kind={input.kind} state={state} t={t} />
          </React.Fragment>
        );
      })}

      {outputs.map((output, i) => {
        const state = outputStates[i];
        const top = HANDLE_TOP + i * HANDLE_GAP;
        return (
          <React.Fragment key={`out-${output.name}`}>
            <Handle
              type="source"
              position={Position.Right}
              id={output.name}
              style={{ top, ...handleStyle(output.kind, state) }}
              title={`${output.label} · ${portKindLabel(output.kind, t)}`}
              data-handle-state={state}
            />
            <PortLabel side="right" top={top} label={output.label} kind={output.kind} state={state} t={t} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** Two-line port caption: the port label above, its kind (in the kind colour) below. */
function PortLabel({ side, top, label, kind, state, t }: { side: 'left' | 'right'; top: number; label: string; kind: PortKind; state: HandleState; t: Translator<'compose'> }) {
  return (
    <div
      className={[
        'absolute -translate-y-1/2 leading-tight transition-opacity',
        side === 'left' ? 'left-3 text-left' : 'right-3 text-right',
        state === 'incompatible' ? 'opacity-30' : '',
      ].join(' ')}
      style={{ top, maxWidth: RECIPE_NODE_WIDTH / 2 - 12 }}
    >
      <div className="truncate text-[11px] text-fg-muted">{label}</div>
      <div className="truncate text-[10px] font-medium" style={{ color: portColor(kind) }}>{portKindLabel(kind, t)}</div>
    </div>
  );
}
