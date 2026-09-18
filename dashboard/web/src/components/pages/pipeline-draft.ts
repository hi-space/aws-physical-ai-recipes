import { z } from 'zod';
import { translatorFor, type Locale, DEFAULT_LOCALE } from '@/lib/i18n/locale';

// Only these reviewed GR00T configuration values may be saved in browser storage.
// New parameters must be classified before persisting them; credentials never belong here.
const nonsecretParameters = new Set([
  'EmbodimentTag', 'HfDatasetId', 'InstanceType', 'EvalInstanceType',
  'MaxSteps', 'GlobalBatchSize', 'NumGpus', 'SaveSteps',
]);
export interface PipelineParameter {
  Name: string;
  DefaultValue?: string | number;
  Type?: string;
}
export const isPersistableParameter = (parameter: PipelineParameter) => nonsecretParameters.has(parameter.Name);
const parameterName = z.string().refine(name => nonsecretParameters.has(name));
const draftSchema = z.strictObject({
  version: z.literal(1),
  owner: z.string().min(1),
  project: z.strictObject({ id: z.string().min(1), name: z.string() }),
  pipelineArn: z.string().min(1),
  fields: z.array(z.strictObject({ Name: parameterName, Type: z.string().optional() })),
  payload: z.strictObject({
    parameters: z.record(parameterName, z.string().max(1024)),
    displayName: z.string().optional(),
  }),
  requestId: z.string().uuid().optional(),
}).refine(draft => {
  const names = draft.fields.map(field => field.Name);
  return new Set(names).size === names.length &&
    JSON.stringify([...names].sort()) === JSON.stringify(Object.keys(draft.payload.parameters).sort());
});
export type PipelineDraft = z.infer<typeof draftSchema>;
const storageKey = 'pai:pipeline-execution-draft:v1';

function getLocale(): Locale {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement.lang?.toLowerCase().split('-')[0];
    if (lang === 'ko' || lang === 'en') return lang;
  }
  return DEFAULT_LOCALE;
}

function getTranslator() {
  return translatorFor(getLocale(), 'pipelines');
}

export function readPipelineDraft(): PipelineDraft | undefined {
  try {
    const saved = sessionStorage.getItem(storageKey);
    return saved === null ? undefined : draftSchema.parse(JSON.parse(saved));
  } catch {
    // Never discard an unreadable request: AWS may already have accepted it.
    const t = getTranslator();
    throw new Error(t('draftRestoreError'));
  }
}

export function savePipelineDraft(draft: PipelineDraft) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(draftSchema.parse(draft)));
  } catch {
    const t = getTranslator();
    throw new Error(t('draftSaveError'));
  }
}

export function clearPipelineDraft(requestId?: string): boolean {
  const current = readPipelineDraft();
  // An older page's delayed response must not erase a newer draft in this tab.
  if (current && current.requestId !== requestId) return false;
  // A failed clear keeps the old identity retryable; it must not permit a new request.
  try { sessionStorage.removeItem(storageKey); return true; }
  catch {
    const t = getTranslator();
    throw new Error(t('draftClearError'));
  }
}

export function releaseRejectedPipelineDraft(attempted: PipelineDraft): PipelineDraft | undefined {
  const current = readPipelineDraft();
  if (!attempted.requestId || current?.requestId !== attempted.requestId) return;
  const editable = { ...current, requestId: undefined };
  savePipelineDraft(editable);
  return editable;
}

export function createPipelineDraft(owner: string, project: { id: string; name: string }, pipelineArn: string, parameters: PipelineParameter[]): PipelineDraft {
  return {
    version: 1, owner, project: { id: project.id, name: project.name }, pipelineArn,
    fields: parameters.map(({ Name, Type }) => ({ Name, Type })),
    payload: { parameters: Object.fromEntries(parameters.map(parameter => [parameter.Name, String(parameter.DefaultValue ?? '')])) },
  };
}

export function invalidPipelineNumbers(draft: PipelineDraft) {
  return draft.fields.filter(field => {
    const value = draft.payload.parameters[field.Name];
    if (field.Type === 'Integer') return !/^(0|[1-9]\d*)$/.test(value);
    if (field.Type === 'Float') return !value.trim() || !Number.isFinite(Number(value));
    return false;
  }).map(field => field.Name);
}

export function pipelineExecutionHref(arn: string, projectId: string) {
  return `/pipelines/${encodeURIComponent(arn)}?${new URLSearchParams({ project: projectId })}`;
}
