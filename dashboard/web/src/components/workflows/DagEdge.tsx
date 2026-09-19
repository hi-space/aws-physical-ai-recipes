'use client';
import * as React from 'react';
import { BaseEdge, getBezierPath, type EdgeProps, type Edge } from '@xyflow/react';

export interface DagEdgeData extends Record<string, unknown> {
  kind: 'task' | 'dataset';
  /** Present when the edge skips over at least one column; the path arcs above this y. */
  arcY?: number;
  highlighted: boolean;
  dimmed: boolean;
  /** Data is flowing (upstream done, downstream running) — draw a moving dash. */
  active: boolean;
}
export type DagEdgeType = Edge<DagEdgeData, 'dag'>;

export const EDGE_COLORS = { task: '#6ea8fe', dataset: '#a78bfa', highlight: '#e6e9f0' } as const;

/**
 * Builds a cubic Bézier whose apex sits exactly at `arcY`. With both control points on the same y, the
 * curve's extreme is (sy + ty) / 8 + 3c / 4, so solving for c places the apex where the layout asked.
 */
export function arcPath(sx: number, sy: number, tx: number, ty: number, arcY: number): string {
  const c = (arcY - (sy + ty) / 8) * (4 / 3);
  const dx = (tx - sx) * 0.3;
  return `M ${sx},${sy} C ${sx + dx},${c} ${tx - dx},${c} ${tx},${ty}`;
}

export function DagEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<DagEdgeType>) {
  const kind = data?.kind ?? 'task';
  const path = data?.arcY !== undefined
    ? arcPath(sourceX, sourceY, targetX, targetY, data.arcY)
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 })[0];
  const color = data?.highlighted ? EDGE_COLORS.highlight : EDGE_COLORS[kind];
  const style: React.CSSProperties = {
    stroke: color,
    strokeWidth: data?.highlighted ? 2.5 : kind === 'dataset' ? 1.5 : 2,
    strokeDasharray: kind === 'dataset' ? '6 4' : data?.active ? '8 6' : undefined,
    opacity: data?.dimmed ? 0.25 : 1,
    transition: 'opacity 200ms, stroke 200ms',
    animation: data?.active ? 'dag-edge-flow 1.2s linear infinite' : undefined,
  };
  return <BaseEdge path={path} style={style} markerEnd={markerEnd} />;
}

export const DAG_EDGE_TYPES = { dag: DagEdge } as const;
