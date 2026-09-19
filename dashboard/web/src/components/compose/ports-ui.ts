'use client';
import { isPortKind, type PortKind } from '@/lib/workflow/ports';
import type { MessageKey, Translator } from '@/lib/i18n';

// PORT_COLORS lives here (not in lib/workflow/ports.ts) per the controller ruling: the palette is a
// UI concern of the composer, and lib/workflow/ports.ts stays free of presentation.
export const PORT_COLORS: Record<PortKind, string> = {
  'lerobot-dataset': '#f59e0b', // amber — raw data
  checkpoint: '#6ea8fe', // accent blue — model weights
  video: '#a78bfa', // violet — rendered frames
  'sdg-frames': '#2dd4bf', // teal — synthetic frames
  'hdf5-demos': '#f472b6', // pink — demonstrations
  artifacts: '#34d399', // green — generic outputs
};

const FALLBACK_COLOR = '#98a2b8';

export function portColor(kind: PortKind): string {
  return PORT_COLORS[kind] ?? FALLBACK_COLOR;
}

const LABEL_KEYS: Record<PortKind, MessageKey<'compose'>> = {
  'lerobot-dataset': 'portKindLerobotDataset',
  checkpoint: 'portKindCheckpoint',
  video: 'portKindVideo',
  'sdg-frames': 'portKindSdgFrames',
  'hdf5-demos': 'portKindHdf5Demos',
  artifacts: 'portKindArtifacts',
};

export function portKindLabel(kind: PortKind, t: Translator<'compose'>): string {
  const key = LABEL_KEYS[kind];
  return key ? t(key) : kind;
}

/**
 * The recorded output kind of a registered dataset, read from its `kind:<PortKind>` tag (written by
 * the producing recipe's publication in artifacts.ts). Returns `undefined` when no such tag exists —
 * the kind is then unverified and the dataset connects to any input.
 */
export function datasetKindFromTags(tags: readonly string[] | undefined): PortKind | undefined {
  for (const tag of tags ?? []) {
    if (tag.startsWith('kind:')) {
      const kind = tag.slice('kind:'.length);
      if (isPortKind(kind)) return kind;
    }
  }
  return undefined;
}
