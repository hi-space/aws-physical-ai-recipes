'use client';
import * as React from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { useT } from '@/lib/i18n';
import type { RecipeMetadata } from '@/lib/workflow/recipe-metadata';
import { portColor, portKindLabel } from './ports-ui';

export interface RecipeNodeData extends Record<string, unknown> {
  title: string;
  category: string;
  recipe?: RecipeMetadata | null;
  selected: boolean;
  onDelete: (nodeId: string) => void;
}
export type RecipeFlowNode = Node<RecipeNodeData, 'recipe'>;

// Handles start below the title/pill block and step down evenly. The node height is derived from the
// larger of the input/output counts so every handle has room (see nodeHeight below).
const HANDLE_TOP = 52;
const HANDLE_GAP = 22;
export const RECIPE_NODE_WIDTH = 208;

export function recipeNodeHeight(recipe?: RecipeMetadata | null): number {
  const rows = Math.max(recipe?.ports?.inputs.length ?? 0, recipe?.ports?.outputs.length ?? 0, 1);
  return HANDLE_TOP + rows * HANDLE_GAP;
}

/** A recipe block: title, category pill, and typed input/output handles coloured by PortKind. */
export function RecipeNode({ id, data, selected }: NodeProps<RecipeFlowNode>) {
  const t = useT('compose');
  const inputs = data.recipe?.ports?.inputs ?? [];
  const outputs = data.recipe?.ports?.outputs ?? [];
  const isSelected = selected || data.selected;

  return (
    <div
      className={[
        'relative rounded-lg border bg-bg-elev shadow-sm transition-[border-color,box-shadow]',
        isSelected ? 'border-accent shadow-[0_0_0_3px_rgba(110,168,254,0.25)]' : 'border-border hover:border-border-strong',
      ].join(' ')}
      style={{ width: RECIPE_NODE_WIDTH, minHeight: recipeNodeHeight(data.recipe) }}
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

      {inputs.map((input, i) => (
        <React.Fragment key={`in-${input.param}`}>
          <Handle
            type="target"
            position={Position.Left}
            id={input.param}
            style={{ top: HANDLE_TOP + i * HANDLE_GAP, width: 10, height: 10, background: portColor(input.kind), borderColor: 'var(--color-bg)' }}
            title={`${input.label} · ${portKindLabel(input.kind, t)}`}
          />
          <span className="absolute left-3 -translate-y-1/2 truncate text-[11px] text-fg-muted" style={{ top: HANDLE_TOP + i * HANDLE_GAP, maxWidth: RECIPE_NODE_WIDTH / 2 - 12 }}>
            {input.label}
          </span>
        </React.Fragment>
      ))}

      {outputs.map((output, i) => (
        <React.Fragment key={`out-${output.name}`}>
          <Handle
            type="source"
            position={Position.Right}
            id={output.name}
            style={{ top: HANDLE_TOP + i * HANDLE_GAP, width: 10, height: 10, background: portColor(output.kind), borderColor: 'var(--color-bg)' }}
            title={`${output.label} · ${portKindLabel(output.kind, t)}`}
          />
          <span className="absolute right-3 -translate-y-1/2 truncate text-right text-[11px] text-fg-muted" style={{ top: HANDLE_TOP + i * HANDLE_GAP, maxWidth: RECIPE_NODE_WIDTH / 2 - 12 }}>
            {output.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}
