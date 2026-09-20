'use client';
import { useConnection } from '@xyflow/react';
import type { PortKind } from '@/lib/workflow/ports';
import type { RecipeMetadata } from '@/lib/workflow/recipe-metadata';
import type { HandleEndpoint } from './composer-state';

/**
 * The endpoint a connection drag started from, or `null` when no drag is in progress. Resolves the
 * dragged handle's PortKind from the source node's data (recipe ports for recipe nodes, the derived
 * `kind` for dataset sources) so every node can run `handleCompatible` against its own handles.
 *
 * The selector returns a flat object, so `useConnection`'s shallow comparison only re-renders nodes when
 * a drag starts or ends — not on every pointer move.
 */
export function useDragEndpoint(): HandleEndpoint | null {
  return useConnection<never, HandleEndpoint | null>((c) => {
    if (!c.inProgress) return null;
    const { fromHandle, fromNode } = c;
    const data = fromNode.data as Record<string, unknown>;
    const type = fromHandle.type;
    if (fromNode.type === 'dataset') return { nodeId: fromNode.id, type, kind: data.kind as PortKind | undefined };
    const ports = (data.recipe as RecipeMetadata | null | undefined)?.ports;
    const kind = type === 'source'
      ? ports?.outputs.find((p) => p.name === fromHandle.id)?.kind
      : ports?.inputs.find((p) => p.param === fromHandle.id)?.kind;
    const bound = type === 'target' && ((data.boundParams as string[] | undefined) ?? []).includes(fromHandle.id ?? '');
    return { nodeId: fromNode.id, type, kind, bound };
  });
}
