import type { RecipePorts } from './ports';

export interface RecipeMetadata {
  revision: string;
  readiness: 'image-required' | 'cpu-validated' | 'prerequisites-required';
  verification: 'local-docker' | 'source-verified-gpu-unverified' | 'source-verified-network-unverified';
  prerequisites: { kind: string; reason: string; parameter?: string; environment?: string }[];
  sources: string[];
  artifacts: string[];
  imageContract: string;
  evaluationType?: 'closed_loop' | 'training_only' | 'communication';
  ports?: RecipePorts;
  views?: Record<string, ('tensorboard' | 'mlflow')[]>;
}
