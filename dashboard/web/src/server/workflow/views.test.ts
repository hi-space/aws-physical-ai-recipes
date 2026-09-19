import { describe, expect, it } from 'vitest';
import { taskViews } from './views';
import YAML from 'yaml';

describe('taskViews', () => {
  const mkSpec = (views?: Record<string, string[]>) => YAML.stringify({
    workflow: { name: 'test', tasks: [] },
    ui: { recipe: { ...(views && { views }) } },
  });

  it('extracts views for a named task', () => {
    const spec = mkSpec({ train: ['tensorboard', 'mlflow'], evaluate: ['tensorboard'] });
    expect(taskViews(spec, 'train')).toEqual(['tensorboard', 'mlflow']);
    expect(taskViews(spec, 'evaluate')).toEqual(['tensorboard']);
  });

  it('returns undefined when views is absent (legacy)', () => {
    const spec = mkSpec();
    expect(taskViews(spec, 'train')).toBeUndefined();
  });

  it('returns [] when views is present but the task has no entry', () => {
    const spec = mkSpec({ train: ['tensorboard'] });
    expect(taskViews(spec, 'unknown')).toEqual([]);
  });

  it('handles invalid YAML gracefully', () => {
    expect(taskViews('{{{', 'train')).toBeUndefined();
  });
});
