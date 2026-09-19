export type PortKind = 'lerobot-dataset' | 'checkpoint' | 'video' | 'sdg-frames' | 'hdf5-demos' | 'artifacts';

export const PORT_KINDS: PortKind[] = ['lerobot-dataset', 'checkpoint', 'video', 'sdg-frames', 'hdf5-demos', 'artifacts'];

export function isPortKind(value: unknown): value is PortKind {
  return typeof value === 'string' && PORT_KINDS.includes(value as PortKind);
}

export interface RecipePorts {
  inputs: { param: string; kind: PortKind; label: string; versionParam?: string }[];
  outputs: { name: string; kind: PortKind; label: string }[];
}
