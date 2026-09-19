'use client';
import * as React from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Database } from 'lucide-react';
import { useT } from '@/lib/i18n';
import type { TaskPhase } from '@/server/store/types';
import { PHASE_HEX } from './utils';

export interface TaskNodeData extends Record<string, unknown> {
  name: string;
  index: number;
  phase?: TaskPhase;
  phaseLabel: string;
  duration?: string;
  attempts?: number;
  parallelism: number;
  gpu?: number;
  cpu?: number | string;
  selected: boolean;
  dimmed: boolean;
  active: boolean;
}
export interface DatasetNodeData extends Record<string, unknown> {
  name: string;
  version?: number | 'latest';
  dimmed: boolean;
  related: boolean;
}
export type TaskNode = Node<TaskNodeData, 'task'>;
export type DatasetNode = Node<DatasetNodeData, 'dataset'>;

const hiddenHandle = '!h-2 !w-2 !min-h-0 !min-w-0 !border-0 !bg-transparent';

/** A task card: phase colour on the left rail, name and phase up top, timing and resource facts underneath. */
export function TaskNodeCard({ data }: NodeProps<TaskNode>) {
  const t = useT('dag');
  const color = data.phase ? PHASE_HEX[data.phase] : PHASE_HEX.WAITING;
  return (
    <div
      role="button"
      aria-pressed={data.selected}
      aria-label={`${data.index + 1}. ${data.name} · ${data.phaseLabel}`}
      className={[
        'group relative flex h-full w-full cursor-pointer select-none flex-col justify-between rounded-lg border bg-bg-elev px-3 py-2 text-left shadow-sm transition-[opacity,box-shadow,border-color] duration-200',
        data.selected ? 'border-accent shadow-[0_0_0_3px_rgba(110,168,254,0.25)]' : 'border-border hover:border-border-strong',
      ].join(' ')}
      style={{ borderLeftWidth: 4, borderLeftColor: color, opacity: data.dimmed ? 0.35 : 1 }}
    >
      <Handle type="target" position={Position.Left} className={hiddenHandle} />
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ background: color }}>
          {data.index + 1}
        </span>
        <span className="truncate text-[15px] font-semibold text-fg" title={data.name}>{data.name}</span>
        <span className={`ml-auto inline-block h-2 w-2 shrink-0 rounded-full ${data.active ? 'pulse' : ''}`} style={{ background: color }} />
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
        <span className="font-medium" style={{ color }}>{data.phaseLabel}</span>
        {data.duration && <span aria-label={t('duration')}>· {data.duration}</span>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-fg-faint">
        {data.gpu ? <span className="rounded bg-bg-elev-2 px-1.5 py-0.5">{t('nodeGpu', { count: data.gpu })}</span> : data.cpu ? <span className="rounded bg-bg-elev-2 px-1.5 py-0.5">{t('nodeCpu', { count: data.cpu })}</span> : null}
        {data.parallelism > 1 && <span className="rounded bg-bg-elev-2 px-1.5 py-0.5">{t('nodeParallel', { count: data.parallelism })}</span>}
        {(data.attempts ?? 0) > 1 && <span className="rounded bg-bg-elev-2 px-1.5 py-0.5 text-warn">{t('nodeAttempts', { count: data.attempts ?? 0 })}</span>}
      </div>
      <Handle type="source" position={Position.Right} className={hiddenHandle} />
    </div>
  );
}

/** A dataset input: a compact pill so the eye reads it as data flowing in, not as a step. */
export function DatasetNodeCard({ data }: NodeProps<DatasetNode>) {
  const t = useT('dag');
  const version = data.version === undefined || data.version === 'latest' ? t('datasetLatest') : t('datasetVersion', { version: data.version });
  return (
    <a
      href={`/datasets/${encodeURIComponent(data.name)}`}
      className={[
        'flex h-full w-full items-center gap-2 rounded-full border border-dashed bg-bg-elev px-3 text-left transition-opacity duration-200 hover:border-accent',
        data.related ? 'border-[#a78bfa]' : 'border-border-strong',
      ].join(' ')}
      style={{ opacity: data.dimmed ? 0.35 : 1 }}
      title={data.name}
    >
      <Database size={14} className="shrink-0 text-[#a78bfa]" aria-hidden />
      <span className="truncate text-[13px] font-medium text-fg">{data.name}</span>
      <span className="ml-auto shrink-0 text-[11px] text-fg-faint">{version}</span>
      <Handle type="source" position={Position.Right} className={hiddenHandle} />
    </a>
  );
}

export const DAG_NODE_TYPES = { task: TaskNodeCard, dataset: DatasetNodeCard } as const;
