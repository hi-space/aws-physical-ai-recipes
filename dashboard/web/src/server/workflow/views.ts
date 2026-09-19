import YAML from 'yaml';

/** Extract the list of views (tensorboard, mlflow) for a task from the workflow spec.
 * Returns undefined only for legacy specs without ui.recipe.views (or unparseable YAML) —
 * callers must treat undefined as "no gating" (show everything). When ui.recipe.views IS
 * present but the task has no entry, returns [] so other tasks in a multi-task recipe stay
 * gated (e.g. a `train` task's tensorboard view must not leak onto `evaluate`/`import`). */
export function taskViews(specYaml: string, taskName: string): ('tensorboard' | 'mlflow')[] | undefined {
  try {
    const spec = YAML.parse(specYaml) as { ui?: { recipe?: { views?: Record<string, string[]> } } };
    const views = spec?.ui?.recipe?.views;
    if (!views || typeof views !== 'object') return undefined;
    const result = views[taskName];
    return Array.isArray(result) ? (result as ('tensorboard' | 'mlflow')[]) : [];
  } catch {
    return undefined;
  }
}
