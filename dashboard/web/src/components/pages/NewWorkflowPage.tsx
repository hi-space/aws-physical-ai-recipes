'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { parseDocument } from 'yaml';
import { Badge, Button, Card, CodeBlock, Dialog, EmptyState, ErrorBox, Field, Input, LinkButton, Select, Spinner, Textarea } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { api, ApiError, can, useApi, useApiMutation, useMe } from '@/lib/api-client';
import { useT, type Translator } from '@/lib/i18n';
import type { Template, TemplateParam } from '@/server/store/types';
import type { ExecutionProfile } from '@/server/services/execution-profiles';

type Mapping = Record<string, unknown>;
type YamlPath = (string | number)[];
const mapping = (value: unknown): value is Mapping => value !== null && typeof value === 'object' && !Array.isArray(value);
const variable = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const reserved = new Set(['output', 'workflow_id', 'task_name', 'replica_index', 'input', 'host']);
const validVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function getCategoryLabels(t: Translator<'newWorkflow'>) {
  return { setup: t('categorySetup'), data: t('categoryData'), training: t('categoryTraining'), evaluation: t('categoryEvaluation'), simulation: t('categorySimulation'), custom: t('categoryCustom') };
}
function getParamLabels(t: Translator<'newWorkflow'>) {
  return { image: t('paramImage'), dataset_name: t('paramDatasetName'), checkpoint_bundle: t('paramCheckpointBundle'), episodes: t('paramEpisodes'), eval_seed: t('paramEvalSeed'), seed: t('paramSeed'), total_steps: t('paramTotalSteps'), num_envs: t('paramNumEnvs'), checkpoint_every: t('paramCheckpointEvery'), resume: t('paramResume') };
}

export interface EvaluationLink { templateId: string; modelId: string; datasetName: string; datasetVersion: number; checkpointBundle: string; episodes: string; evalSeed: string }
interface EvaluationModel { id: string; source: { dataset: { name: string; version: number } }; bundle?: { path: string }; checkpointBundle?: { path: string }; evaluationLaunch?: { template: string }; evaluationUnavailableReason?: string }
interface CredentialOption { id?: string; name?: string; kind?: string; scope?: string; ref: string; status: string }
interface CredentialBinding { key: string; path: YamlPath; label: string; ref: string; parameter?: string }
type WorkflowPreset = 'cpu-quick';
const cpuQuickDefaults = { total_steps: '512', num_envs: '1', episodes: '20' } as const;
interface Selection { id: string; version?: number; preset?: WorkflowPreset }
interface Draft { yaml: string; template?: Template; selectionKey?: string }
interface ImagePreflight { status: 'blocked' | 'needs-review'; findings: Array<{ code: string; severity: 'error' | 'warning' | 'unknown'; message: string; task?: string }> }
interface ValidationResult { ok: boolean; preflight?: ImagePreflight; order?: string[]; error?: string; details?: { issues?: string[] }; tasks?: Array<{ name: string; image: string; resource: { cpu?: string | number; gpu?: number; memory?: string }; parallelism: number }> }

function documentOf(yaml: string) {
  const document = parseDocument(yaml);
  if (document.errors.length) throw new Error('Check YAML syntax.');
  const root: unknown = document.toJS({ maxAliasCount: 50 });
  if (!mapping(root) || !mapping(root.workflow)) throw new Error('Enter YAML with workflow object.');
  return { document, root, workflow: root.workflow };
}
function defaultsOf(yaml: string): Record<string, string> {
  const defaults = documentOf(yaml).root['default-values'];
  if (defaults !== undefined && !mapping(defaults)) throw new Error('default-values must be name-value mapping.');
  return Object.fromEntries(Object.entries(defaults ?? {}).map(([name, value]) => {
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`Check parameter ${name} value`);
    return [name, String(value)];
  }));
}
function tasksOf(root: Mapping) {
  const workflow = root.workflow as Mapping;
  const tasks: Array<{ task: Mapping; path: YamlPath }> = [];
  const add = (list: unknown, path: YamlPath) => {
    if (Array.isArray(list)) list.forEach((task, index) => { if (mapping(task)) tasks.push({ task, path: [...path, index] }); });
  };
  add(workflow.tasks, ['workflow', 'tasks']);
  if (Array.isArray(workflow.groups)) workflow.groups.forEach((group, index) => { if (mapping(group)) add(group.tasks, ['workflow', 'groups', index, 'tasks']); });
  return tasks;
}
export function chooseExecutionProfile(yaml: string, taskName: string, profile?: { id: string; version: number }): string {
  const { document, root } = documentOf(yaml);
  const matches = tasksOf(root).filter(({ task }) => task.name === taskName);
  if (!matches.length) throw new Error(`Execution profile task not found.`);
  for (const { path } of matches) {
    if (profile) document.setIn([...path, 'executionProfile'], { id: profile.id, version: profile.version });
    else document.deleteIn([...path, 'executionProfile']);
  }
  return document.toString({ lineWidth: 0 });
}
export function credentialBindings(yaml: string): CredentialBinding[] {
  const { root } = documentOf(yaml);
  return tasksOf(root).flatMap(({ task, path }) => {
    if (!mapping(task.credentials)) return [];
    return Object.entries(task.credentials).flatMap(([group, values]) => !mapping(values) ? [] : Object.entries(values).map(([environment, value]) => {
      const ref = typeof value === 'string' ? value : '';
      const location = [...path, 'credentials', group, environment];
      return { key: JSON.stringify(location), path: location, label: `${String(task.name ?? 'task')} · ${environment}`, ref, parameter: variable.exec(ref)?.[1] };
    }));
  });
}
export function readEvaluationQuery(query: URLSearchParams): EvaluationLink | undefined {
  if (!query.has('model_id')) return undefined;
  const read = (key: string) => {
    const values = query.getAll(key);
    if (values.length !== 1 || !values[0]) throw new Error(`Check model evaluation link parameter ${key}`);
    return values[0];
  };
  const templateId = read('template'), modelId = read('model_id'), datasetName = read('dataset_name');
  if (!/^[a-z0-9-]{1,40}$/.test(templateId) || !/^[a-z0-9-]{1,100}$/.test(modelId) || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(datasetName)) throw new Error(`Model evaluation link identifiers invalid.`);
  const version = read('dataset_version'), episodes = read('episodes'), evalSeed = read('eval_seed'), checkpointBundle = read('checkpoint_bundle');
  if (!/^[1-9][0-9]*$/.test(version) || !validVersion(Number(version))) throw new Error(`Evaluation dataset version must be positive integer.`);
  if (!/^[1-9][0-9]*$/.test(episodes) || Number(episodes) > 100000 || !/^[0-9]+$/.test(evalSeed) || Number(evalSeed) > 4294967295) throw new Error(`Check evaluation episodes and seed.`);
  if (checkpointBundle.length > 2048 || /[\\\x00-\x1f]/.test(checkpointBundle) || checkpointBundle.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Checkpoint bundle must be relative path in dataset.`);
  return { templateId, modelId, datasetName, datasetVersion: Number(version), checkpointBundle, episodes, evalSeed };
}
export function assertEvaluationModel(link: EvaluationLink, model: EvaluationModel) {
  if (model?.id !== link.modelId || model.evaluationLaunch?.template !== link.templateId || model.source?.dataset.name !== link.datasetName ||
    model.source.dataset.version !== link.datasetVersion || (model.bundle?.path ?? model.checkpointBundle?.path) !== link.checkpointBundle) throw new Error(`Evaluation link does not match model dataset and checkpoint. Start from model screen.`);
}
function replaceVariables(value: string, variables: Record<string, string>) {
  return value.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?::([^}]+))?\s*\}\}/g, (match, name: string, suffix?: string) => {
    if (reserved.has(name) || suffix !== undefined) return match;
    if (!Object.hasOwn(variables, name)) throw new Error(`Parameter ${name} value missing`);
    return variables[name];
  });
}
export function initializeWorkflowYaml(template: Template, link?: EvaluationLink, preset?: WorkflowPreset): string {
  const { document } = documentOf(template.yaml);
  const defaults = { ...defaultsOf(template.yaml), ...Object.fromEntries(template.params.map((param) => [param.name, param.default ?? ''])) };
  for (const binding of credentialBindings(template.yaml)) {
    if (binding.parameter) defaults[binding.parameter] = '';
    else document.setIn(binding.path, '');
  }
  if (link) {
    if (template.id !== link.templateId || !['dataset_name', 'checkpoint_bundle', 'episodes', 'eval_seed'].every((name) => template.params.some((param) => param.name === name))) throw new Error(`This recipe version does not support model evaluation.`);
    Object.assign(defaults, { dataset_name: link.datasetName, dataset_version: String(link.datasetVersion), checkpoint_bundle: link.checkpointBundle, episodes: link.episodes, eval_seed: link.evalSeed, model_id: link.modelId });
    let bound = 0;
    for (const { task, path } of tasksOf(document.toJS({ maxAliasCount: 50 }) as Mapping)) {
      if (Array.isArray(task.inputs)) task.inputs.forEach((input, index) => {
        if (mapping(input) && mapping(input.dataset) && typeof input.dataset.name === 'string' && replaceVariables(input.dataset.name, defaults) === link.datasetName) {
          document.setIn([...path, 'inputs', index, 'dataset', 'version'], link.datasetVersion); bound++;
        }
      });
    }
    if (!bound) throw new Error(`No input available to connect model dataset.`);
    document.setIn(['workflow', 'labels', 'model_id'], link.modelId);
  }
  if (preset === 'cpu-quick') {
    if (link || template.id !== 'mujoco-pipeline' || !Object.keys(cpuQuickDefaults).every(name => template.params.some(param => param.name === name))) {
      throw new Error(`This recipe version does not support CPU quick start.`);
    }
    Object.assign(defaults, cpuQuickDefaults);
  }
  document.set('default-values', defaults);
  return document.toString({ lineWidth: 0 });
}
export function renderWorkflowYaml(yaml: string, options: { namespace?: string; priority?: string } = {}) {
  const { document, root } = documentOf(yaml);
  const variables = defaultsOf(yaml);
  const render = (value: unknown): unknown => {
    if (typeof value === 'string') return replaceVariables(value, variables);
    if (Array.isArray(value)) return value.map(render);
    if (mapping(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item)]));
    return value;
  };
  for (const [key, value] of Object.entries(root)) if (key !== 'default-values') document.set(key, document.createNode(render(value)));
  document.set('default-values', document.createNode(variables));
  if (options.namespace) document.setIn(['workflow', 'namespace'], options.namespace);
  if (options.priority !== undefined) {
    if (options.priority) document.setIn(['workflow', 'priority'], options.priority);
    else document.deleteIn(['workflow', 'priority']);
  }
  return document.toString({ lineWidth: 0 });
}
export function chooseCredential(yaml: string, key: string, ref: string) {
  const binding = credentialBindings(yaml).find((candidate) => candidate.key === key);
  if (!binding) throw new Error(`Credential input changed. Check YAML.`);
  const { document } = documentOf(yaml);
  document.setIn(binding.parameter ? ['default-values', binding.parameter] : binding.path, ref);
  return document.toString({ lineWidth: 0 });
}
export function assertRegisteredCredentials(yaml: string, credentials: CredentialOption[] | undefined) {
  const bindings = credentialBindings(yaml);
  if (!bindings.length) return;
  if (!credentials) throw new Error(`Check credential list before execution.`);
  const allowed = new Set(credentials.filter((credential) => ['READY', 'REGISTERED'].includes(credential.status)).map((credential) => credential.ref));
  if (bindings.some((binding) => !binding.ref || !allowed.has(binding.ref))) throw new Error(`Select available credential references. Do not enter secrets directly.`);
}
export function workflowSubmissionPayload(yaml: string, template?: Template, namespace?: string, acknowledgePreflight = false) {
  if (template?.id === 'gr00t-pipeline') throw new Error(`Legacy GR00T EKS recipe not supported. Use GR00T full pipeline.`);
  if (template && !validVersion(template.templateVersion)) throw new Error(`Recipe version not verified. Try again when version API ready.`);
  return { yaml, ...(template ? { templateId: template.id, templateVersion: template.templateVersion } : {}), ...(namespace ? { namespace } : {}), ...(acknowledgePreflight === true ? { acknowledgePreflight: true } : {}) };
}
export function savedTemplatePayload(yaml: string, template: Template | undefined, input: { id: string; title: string; description: string; category: Template['category'] }, currentVersion?: number) {
  return { ...input, yaml,
    params: Object.entries(defaultsOf(yaml)).map(([name, value]): TemplateParam => ({ ...(template?.params.find((param) => param.name === name) ?? { name, label: name, type: 'string' as const }), default: value })),
    ...(template?.requires ? { requires: [...template.requires] } : {}),
    ...(template && !template.builtin && input.id === template.id && validVersion(currentVersion ?? template.templateVersion) ? { baseVersion: currentVersion ?? template.templateVersion } : {}),
  };
}
function selectionFromQuery(query: URLSearchParams): Selection | null {
  const id = query.get('template');
  if (!id) return null;
  if (id === 'gr00t-pipeline') throw new Error(`Legacy GR00T EKS recipe archived. Use GR00T full pipeline.`);
  if (query.getAll('template').length !== 1 || !/^[a-z0-9-]{1,40}$/.test(id)) throw new Error(`Check recipe selection link.`);
  const version = query.get('templateVersion');
  if (version !== null && (query.getAll('templateVersion').length !== 1 || !/^[1-9][0-9]*$/.test(version) || !validVersion(Number(version)))) throw new Error(`Recipe version must be positive integer.`);
  const preset = query.get('preset');
  if (preset !== null && (query.getAll('preset').length !== 1 || preset !== 'cpu-quick' || id !== 'mujoco-pipeline')) throw new Error(`Unsupported quick start preset.`);
  return { id, ...(version ? { version: Number(version) } : {}), ...(preset === 'cpu-quick' ? { preset: 'cpu-quick' as const } : {}) };
}
function assertEvaluationDraft(yaml: string, link: EvaluationLink) {
  const { root } = documentOf(yaml);
  const inputs = tasksOf(root).flatMap(({ task }) => Array.isArray(task.inputs) ? task.inputs : []).filter((input) => mapping(input) && mapping(input.dataset) && input.dataset.name === link.datasetName);
  const defaults = defaultsOf(yaml);
  if (!inputs.length || inputs.some((input) => (input as { dataset: { version: unknown } }).dataset.version !== link.datasetVersion) || defaults.checkpoint_bundle !== link.checkpointBundle || defaults.dataset_name !== link.datasetName) throw new Error(`Keep model dataset version and checkpoint. Edit other inputs after disconnect.`);
}

export function NewWorkflowPage() {
  const t = useT('newWorkflow');
  const tc = useT('common');
  const categoryLabels = getCategoryLabels(t);
  const paramLabels = getParamLabels(t);
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const query = useMemo(() => {
    try { const params = new URLSearchParams(search); return { selection: selectionFromQuery(params), evaluation: readEvaluationQuery(params), error: undefined }; }
    catch (error) { return { selection: null, evaluation: undefined, error }; }
  }, [search]);
  const me = useMe();
  const executionProfiles = useApi<{ profiles: ExecutionProfile[] }>(me.data?.role === 'admin' ? '/api/execution-profiles' : null);
  const templates = useApi<Template[]>('/api/templates', { refetch: 15000 });
  const credentials = useApi<{ projectId: string; credentials: CredentialOption[] }>('/api/credentials', { refetch: 15000 });
  const queues = useApi<{ priorityClasses: Array<{ name: string }> }>('/api/queues');
  const [selection, setSelection] = useState<Selection | null>(() => query.selection);
  const [step, setStep] = useState(query.selection ? 2 : 1);
  const [draft, setDraft] = useState<Draft>({ yaml: '' });
  const [detached, setDetached] = useState(false);
  const [priority, setPriority] = useState<string>();
  const [actionError, setActionError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [validation, setValidation] = useState<{ inputKey: string; result: ValidationResult }>();
  const [reviewedValidation, setReviewedValidation] = useState<typeof validation>();
  const [validationAttempt, setValidationAttempt] = useState(0);
  const previousSearch = useRef(search);
  const cloneChecked = useRef(false);
  const idempotency = useRef<{ yaml: string; key: string } | undefined>(undefined);
  const evaluation = detached ? undefined : query.evaluation;
  const detailPath = selection ? `/api/templates/${encodeURIComponent(selection.id)}${selection.version ? `?version=${selection.version}` : ''}` : null;
  const templateDetail = useApi<Template>(detailPath, { refetch: selection && !selection.version ? 5000 : 0 });
  const history = useApi<Template[]>(selection?.version ? `/api/templates/${encodeURIComponent(selection.id)}/versions` : null);
  const model = useApi<{ model: EvaluationModel; canWrite: boolean }>(evaluation ? `/api/models/${encodeURIComponent(evaluation.modelId)}` : null);
  const selectionKey = selection ? `${selection.id}@${selection.version ?? 'latest'}:${selection.preset ?? 'custom'}` : undefined;
  const templateReady = !selection || draft.selectionKey === selectionKey && validVersion(draft.template?.templateVersion);

  useEffect(() => {
    if (previousSearch.current !== search) {
      previousSearch.current = search; setSelection(query.selection); setDetached(false); setDraft({ yaml: '' }); setPriority(undefined); setActionError(undefined); setStep(query.selection ? 2 : 1);
    }
    if (!cloneChecked.current) {
      cloneChecked.current = true;
      if (!query.selection && !query.error) {
        const clone = sessionStorage.getItem('pai.cloneYaml');
        if (clone) { setDraft({ yaml: clone }); setSelection(null); setStep(3); sessionStorage.removeItem('pai.cloneYaml'); }
      }
    }
  }, [search, query]);
  useEffect(() => {
    const template = templateDetail.data;
    if (!selection || !template || template.id !== selection.id || draft.selectionKey === selectionKey) return;
    if (!validVersion(template.templateVersion)) return;
    if (!selection.version) { setSelection({ ...selection, version: template.templateVersion }); return; }
    if (selection.version !== template.templateVersion || evaluation && !model.data) return;
    try {
      if (evaluation) assertEvaluationModel(evaluation, model.data!.model);
      setDraft({ template, selectionKey, yaml: initializeWorkflowYaml(template, evaluation, selection.preset) });
      setPriority(undefined); setActionError(undefined);
    } catch (error) { setActionError(error); }
  }, [selection, selectionKey, templateDetail.data, draft.selectionKey, evaluation, model.data]);

  const derived = useMemo<{ rendered: string; defaults: Record<string, string>; bindings: CredentialBinding[]; error: unknown }>(() => {
    try {
      if (!draft.yaml.trim()) return { rendered: '', defaults: {}, bindings: [], error: undefined };
      const rendered = renderWorkflowYaml(draft.yaml, { namespace: me.data?.defaultNamespace, priority });
      return { rendered, defaults: defaultsOf(draft.yaml), bindings: credentialBindings(draft.yaml), error: undefined };
    } catch (error) { return { rendered: '', defaults: {}, bindings: [], error }; }
  }, [draft.yaml, me.data?.defaultNamespace, priority]);
  // Include the source as well as rendered variables so even an equivalent YAML edit needs fresh consent.
  const validationKey = JSON.stringify([draft.yaml, derived.rendered, me.data?.project?.id]);
  const preflightError = useMemo(() => {
    if (query.error) return query.error;
    if (derived.error) return derived.error;
    if (!derived.rendered) return undefined;
    try {
      if (!templateReady) throw new Error(`Loading fixed recipe version.`);
      if (evaluation) {
        if (!model.data || model.error) throw new Error(`Check registered model before evaluation.`);
        assertEvaluationModel(evaluation, model.data.model); assertEvaluationDraft(derived.rendered, evaluation);
      }
      const registered = !credentials.error && (!me.data?.project || credentials.data?.projectId === me.data.project.id) ? credentials.data?.credentials : undefined;
      assertRegisteredCredentials(derived.rendered, registered);
      return undefined;
    } catch (error) { return error; }
  }, [query.error, derived, templateReady, evaluation, model.data, model.error, credentials.data, credentials.error, me.data?.project]);
  useEffect(() => {
    setValidation(undefined);
    setReviewedValidation(undefined);
    if (!derived.rendered || preflightError) return;
    const abort = new AbortController(); const snapshot = derived.rendered;
    const timer = setTimeout(async () => {
      try {
        const result = await api<ValidationResult>('/api/workflows/validate', { method: 'POST', json: { yaml: snapshot }, signal: abort.signal });
        if (!abort.signal.aborted) setValidation({ inputKey: validationKey, result });
      } catch (error) {
        if (!abort.signal.aborted) setValidation({ inputKey: validationKey, result: { ok: false, error: error instanceof Error ? error.message : `Failed to validate execution config.` } });
      }
    }, 400);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [derived.rendered, validationKey, preflightError, validationAttempt]);

  const submit = useApiMutation(async (input: { payload: ReturnType<typeof workflowSubmissionPayload>; key: string }) => api<{ id?: string; runId?: string }>('/api/workflows', { method: 'POST', headers: { 'idempotency-key': input.key }, json: input.payload }));
  const save = useApiMutation(async (payload: ReturnType<typeof savedTemplatePayload>) => api<Template>('/api/templates', { method: 'POST', json: payload }), ['/api/templates']);
  const canWrite = can(me.data, 'researcher') && !!me.data?.project && me.data.project.role !== 'viewer' && (!evaluation || model.data?.canWrite === true);
  const currentValidation = validation?.inputKey === validationKey ? validation : undefined;
  const validated = currentValidation?.result.ok && !preflightError && templateReady;
  const imagePreflight = currentValidation?.result.preflight;
  // A new response is a new review, even when its YAML and findings happen to match.
  const acknowledgedPreflight = !!currentValidation && reviewedValidation === currentValidation;
  const preflightAllowed = !imagePreflight || imagePreflight.status === 'needs-review' && acknowledgedPreflight;
  const busy = submit.isPending || save.isPending;
  const readyCredentials = credentials.data?.credentials.filter((credential) => ['READY', 'REGISTERED'].includes(credential.status)) ?? [];
  const credentialParams = new Set(derived.bindings.flatMap((binding) => binding.parameter ? [binding.parameter] : []));
  const templateGroups = Object.entries(categoryLabels).map(([id, label]) => ({ id, label, templates: (templates.data ?? []).filter((template) => template.category === id && template.id !== 'gr00t-pipeline') }));
  const versions = [...new Map([...(history.data ?? []), ...(draft.template ? [draft.template] : [])].filter((template) => validVersion(template.templateVersion)).map((template) => [template.templateVersion, template])).values()].sort((a, b) => b.templateVersion! - a.templateVersion!);

  function editDefault(name: string, value: string) {
    try { const { document } = documentOf(draft.yaml); document.setIn(['default-values', name], value); setDraft((previous) => ({ ...previous, yaml: document.toString({ lineWidth: 0 }) })); setActionError(undefined); }
    catch (error) { setActionError(error); }
  }
  function disconnectModel() {
    setDetached(true);
    try { const { document } = documentOf(draft.yaml); document.deleteIn(['workflow', 'labels', 'model_id']); document.deleteIn(['default-values', 'model_id']); setDraft((previous) => ({ ...previous, yaml: document.toString({ lineWidth: 0 }) })); } catch { /* Empty/invalid YAML remains editable. */ }
  }
  function recheckPreflight() {
    setReviewedValidation(undefined); setValidation(undefined); setValidationAttempt((attempt) => attempt + 1);
  }
  async function handleSubmit() {
    if (!validated || !preflightAllowed || !canWrite || busy) return;
    setActionError(undefined); setNotice('');
    try {
      const payload = workflowSubmissionPayload(derived.rendered, draft.template, me.data?.defaultNamespace, !!imagePreflight && acknowledgedPreflight);
      const snapshot = JSON.stringify(payload);
      if (idempotency.current?.yaml !== snapshot) idempotency.current = { yaml: snapshot, key: crypto.randomUUID() };
      const result = await submit.mutateAsync({ payload, key: idempotency.current.key });
      const id = result.runId ?? result.id;
      if (!id) throw new Error(`Failed to receive run ID. Check run list.`);
      router.push(`/workflows/${encodeURIComponent(id)}`);
    } catch (error) {
      setActionError(error);
      if (error instanceof ApiError && (error.status === 428 || error.code === 'image_preflight_blocked' || error.code === 'image_approval_changed')) recheckPreflight();
    }
  }
  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canWrite || busy || preflightError) return;
    const fields = new FormData(event.currentTarget); setActionError(undefined);
    try {
      const result = await save.mutateAsync(savedTemplatePayload(draft.yaml, draft.template, { id: String(fields.get('id')), title: String(fields.get('title')), description: String(fields.get('description')), category: String(fields.get('category')) as Template['category'] }, versions[0]?.templateVersion));
      if (!validVersion(result.templateVersion)) throw new Error(`Save response missing version info. Check recipe list.`);
      setShowSave(false); setNotice(`Saved ${result.id} v${result.templateVersion}`);
    } catch (error) { setActionError(error); }
  }
  function downloadYaml() {
    const url = URL.createObjectURL(new Blob([derived.rendered || draft.yaml], { type: 'text/yaml' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'workflow.yaml'; anchor.click(); URL.revokeObjectURL(url);
  }

  return <div className="space-y-5">
    <PageHeader title={t('title')} description={t('description')}
      actions={<LinkButton href="/pipelines">{t('pipelineLink')}</LinkButton>} />
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton href="/workflows/new?template=mujoco-pipeline&preset=cpu-quick" variant="primary">{t('cpuQuickStart')}</LinkButton>
      <p className="text-xs text-fg-muted">{t('cpuQuickHint')}</p>
    </div>
    {actionError !== undefined && <ErrorBox error={actionError} />}
    {query.error !== undefined && <ErrorBox error={query.error} />}
    {me.error && <ErrorBox error={me.error} />}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {evaluation && <Card title={t('evaluationCard')} description={`${evaluation.modelId} · ${evaluation.datasetName} v${evaluation.datasetVersion} · ${evaluation.checkpointBundle}`} actions={<Button size="sm" variant="ghost" onClick={disconnectModel} disabled={busy}>{t('disconnectModel')}</Button>}>
      {model.isLoading && <Spinner label={t('loadingModel')} />}{model.error && <ErrorBox error={model.error} />}
      <p className="text-xs text-fg-muted">{t('evaluationDesc')}</p>
    </Card>}
    <nav aria-label={t('workflowSteps')} className="grid grid-cols-3 gap-3">{[t('stepRecipe'), t('stepInputs'), t('stepYaml')].map((label, index) => <button key={label} type="button" aria-current={step === index + 1 ? 'step' : undefined} onClick={() => setStep(index + 1)} className={`rounded border p-3 text-left ${step === index + 1 ? 'border-accent bg-accent/10' : 'border-border'}`}><span className="text-xs">{index + 1}{t('stepLabel')}</span><span className="block text-sm">{label}</span></button>)}</nav>
    {step === 1 && <div className="space-y-4">
      {templates.error && <ErrorBox error={templates.error} />}{templates.isLoading && <Spinner label={t('loadingRecipes')} />}
      {!templates.isLoading && !templates.error && !templates.data?.length && <EmptyState title={t('noRecipes')} />}
      {templateGroups.map((group) => group.templates.length > 0 && <section key={group.id} aria-label={group.label}>
        <h2 className="text-sm font-semibold mb-2">{group.label}</h2>
        <div className="grid gap-3 md:grid-cols-2">{group.templates.map((template) => <button key={template.id} type="button" aria-pressed={selection?.id === template.id} onClick={() => {
          if (evaluation && evaluation.templateId !== template.id) setDetached(true);
          setSelection({ id: template.id, version: validVersion(template.templateVersion) ? template.templateVersion : undefined }); setDraft({ yaml: '' }); setStep(2); setActionError(undefined);
        }} className="rounded border border-border p-4 text-left hover:bg-bg-elev-2 focus-visible:outline focus-visible:outline-accent">
          <span className="font-semibold text-sm">{template.title}</span> <Badge>{validVersion(template.templateVersion) ? `v${template.templateVersion}` : t('versionNotReady')}</Badge>
          <span className="block text-xs text-fg-muted mt-2">{template.description}</span>
          <span className="flex gap-1 mt-2">{template.requires?.map((requirement) => <Badge key={requirement}>{requirement}</Badge>)}</span>
        </button>)}</div>
      </section>)}
      <Button variant="ghost" disabled={busy} onClick={() => {
        // Editing a selected recipe retains its immutable source revision and model binding.
        if (!draft.template) setSelection(null);
        setStep(3);
      }}>{t('yamlInput')}</Button>
    </div>}
    {selection && (step === 2 || step === 3) && <Card title={draft.template?.title ?? selection.id} description={t('recipeVersionNote')}>
      {templateDetail.error && <ErrorBox error={templateDetail.error} />}
      {!templateReady && <p role="status" className="text-sm">{templateDetail.isFetching ? t('checkingVersion') : t('publishedVersionNotFound')}</p>}
      {templateDetail.data && selection.version && templateDetail.data.templateVersion !== selection.version && <ErrorBox error={{ message: t('versionMismatch') }} />}
      {versions.length > 0 && <Field label={t('recipeVersionField')}><Select id="template-version" value={selection.version ?? ''} disabled={busy} onChange={(event) => { setSelection({ ...selection, version: Number(event.target.value) }); setDraft({ yaml: '' }); setActionError(undefined); }}>
        {versions.map((version) => <option key={version.templateVersion} value={version.templateVersion}>v{version.templateVersion}</option>)}
      </Select></Field>}
      {history.error && <ErrorBox error={history.error} />}
    </Card>}
    {step === 2 && <div className="space-y-4">
      {!selection && !draft.yaml && <EmptyState title={t('selectOrYaml')} />}
      {templateReady && draft.template?.params.filter((param) => !credentialParams.has(param.name)).map((param) => {
        const value = derived.defaults[param.name] ?? ''; const locked = !!evaluation && ['dataset_name', 'checkpoint_bundle'].includes(param.name);
        const paramKey = param.name as keyof typeof paramLabels;
        return <Field key={param.name} label={paramLabels[paramKey] ?? param.label} help={locked ? t('locked') : param.help}>
          {param.type === 'boolean' ? <input id={`param-${param.name}`} type="checkbox" checked={value === 'true'} disabled={busy || locked} onChange={(event) => editDefault(param.name, String(event.target.checked))} />
            : param.type === 'select' ? <Select id={`param-${param.name}`} value={value} disabled={busy || locked} onChange={(event) => editDefault(param.name, event.target.value)}>{param.options?.map((option) => <option key={option} value={option}>{option}</option>)}</Select>
            : param.type === 'text' ? <Textarea id={`param-${param.name}`} value={value} readOnly={locked} disabled={busy} onChange={(event) => editDefault(param.name, event.target.value)} />
            : <Input id={`param-${param.name}`} type={param.type === 'number' ? 'number' : 'text'} step={param.type === 'number' ? 'any' : undefined} value={value} readOnly={locked} disabled={busy} onChange={(event) => editDefault(param.name, event.target.value)} />}
        </Field>;
      })}
      {derived.bindings.length > 0 && <Card title={t('credentials')} description={t('credentialsDesc')}>
        {credentials.error && <ErrorBox error={credentials.error} />}{credentials.isLoading && <Spinner label={t('loadingCredentials')} />}
        {derived.bindings.map((binding) => <Field key={binding.key} label={binding.label}>
          <Select value={binding.parameter ? derived.defaults[binding.parameter] ?? '' : binding.ref} disabled={busy || credentials.isLoading || !!credentials.error} onChange={(event) => {
            try { setDraft((previous) => ({ ...previous, yaml: chooseCredential(previous.yaml, binding.key, event.target.value) })); setActionError(undefined); } catch (error) { setActionError(error); }
          }}><option value="">{t('selectCredential')}</option>{readyCredentials.map((credential) => <option key={credential.ref} value={credential.ref}>{credential.name ?? credential.ref} · {credential.kind ?? 'generic'} · {credential.scope === 'project' ? t('credentialProjectScope') : t('credentialPrivateScope')}</option>)}</Select>
        </Field>)}
        {!credentials.isLoading && !credentials.error && !readyCredentials.length && <p className="text-xs text-fg-muted">{t('noCredentialsReady')}</p>}
        <LinkButton href="/access" size="sm">{t('credentialManagement')}</LinkButton>
      </Card>}
      <Field label={t('executionNamespace')} help={t('executionNamespaceHelp')}><Input readOnly value={me.data?.defaultNamespace ?? ''} /></Field>
      {queues.error && <ErrorBox error={queues.error} />}
      {!!queues.data?.priorityClasses.length && <Field label={t('priority')}><Select value={priority ?? ''} onChange={(event) => setPriority(event.target.value)}><option value="">{t('priorityDefault')}</option>{queues.data.priorityClasses.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</Select></Field>}
      {preflightError !== undefined && <ErrorBox error={preflightError} />}
      <Button onClick={() => setStep(3)}>{t('checkYaml')}</Button>
    </div>}
    {step === 3 && <div className="space-y-4">
      {!!executionProfiles.data?.profiles.some(profile => profile.enabled) && <Card title={t('executeProfiles')}
        description={t('executeProfilesDesc')}>
        {(() => {
          try {
            return tasksOf(documentOf(draft.yaml).root).map(({ task, path }) => <Field key={JSON.stringify(path)} label={String(task.name)}>
              <Select aria-label={`${String(task.name)} ${t('executeProfiles')}`}
                value={mapping(task.executionProfile) ? `${task.executionProfile.id}@${task.executionProfile.version}` : ''}
                onChange={event => {
                  const selected = executionProfiles.data?.profiles.find(profile => `${profile.id}@${profile.version}` === event.target.value);
                  try { setDraft(previous => ({ ...previous, yaml: chooseExecutionProfile(previous.yaml, String(task.name), selected) })); setActionError(undefined); }
                  catch (error) { setActionError(error); }
                }}>
                <option value="">{t('generalProjectExecution')}</option>
                {executionProfiles.data?.profiles.filter(profile => profile.enabled && profile.approvedTask.name === task.name)
                  .map(profile => <option key={profile.id} value={`${profile.id}@${profile.version}`}>{profile.name} · v{profile.version}</option>)}
              </Select>
            </Field>);
          } catch { return <p className="text-sm text-fg-muted">{t('taskList')}</p>; }
        })()}
        <LinkButton href="/image-profiles" size="sm" className="mt-3">{t('profilesApprovalHistory')}</LinkButton>
      </Card>}
      <Field label={t('workflowYaml')} help={t('yamlHelp')}><Textarea id="workflow-yaml" value={draft.yaml} rows={24} maxLength={1024 * 1024} disabled={busy} className="font-mono text-xs" onChange={(event) => { setDraft((previous) => ({ ...previous, yaml: event.target.value })); setPriority(undefined); }} /></Field>
      {preflightError !== undefined && <ErrorBox error={preflightError} />}
      {derived.rendered && <details><summary className="cursor-pointer text-sm">{t('yamlPreview')}</summary><CodeBlock code={derived.rendered} lang="yaml" /></details>}
      {currentValidation ? currentValidation.result.ok ? <p role="status" className="text-sm text-ok">{t('validationPassed', { count: currentValidation.result.tasks?.length ?? 0, order: currentValidation.result.order?.join(' → ') ?? '' })}</p>
        : <ErrorBox error={{ message: currentValidation.result.error ?? t('validationError'), details: currentValidation.result.details }} />
        : derived.rendered && !preflightError && <p role="status" className="text-sm text-fg-muted">{t('validating')}</p>}
      {imagePreflight && <Card title={t('imagePreflight')}
        description={imagePreflight.status === 'blocked' ? t('preflightBlocked') : t('preflightNeedsReview')}
        actions={<Button size="sm" variant="ghost" disabled={busy} onClick={recheckPreflight}>{t('recheck')}</Button>}>
        <ul className="space-y-2 text-sm" aria-label={t('preflightFindings')}>{imagePreflight.findings.map((finding, index) => <li key={`${finding.task ?? ''}:${finding.code}:${index}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{({ error: t('preflightBadge'), warning: t('preflightWarning'), unknown: t('preflightUnknown') })[finding.severity] ?? t('preflightUnknown')}</Badge>
            {finding.task && <span>{t('preflightTask')}: {finding.task}</span>}<code className="text-xs text-fg-muted">{finding.code}</code>
          </div>
          <p className="mt-1">{finding.message}</p>
        </li>)}</ul>
        {imagePreflight.status === 'needs-review' && <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={acknowledgedPreflight} disabled={!validated || busy} onChange={(event) => setReviewedValidation(event.target.checked ? currentValidation : undefined)} />
          <span>{t('acknowledgePrecheck')}</span>
        </label>}
      </Card>}
      {!canWrite && <p className="text-sm text-fg-muted">{t('noWritePermission')}</p>}
      <div className="flex flex-wrap gap-2"><Button variant="primary" onClick={handleSubmit} disabled={!validated || !preflightAllowed || !canWrite || busy} loading={submit.isPending}>{t('executeWorkflow')}</Button>
        <Button variant="ghost" onClick={() => setShowSave(true)} disabled={!draft.yaml || !!preflightError || !canWrite || busy}>{t('saveAsRecipe')}</Button>
        <Button variant="ghost" onClick={downloadYaml} disabled={!draft.yaml}>{t('downloadYaml')}</Button><Button variant="ghost" onClick={() => setStep(2)}>{t('backToInputs')}</Button>
      </div>
    </div>}
    <Dialog open={showSave} onClose={() => !save.isPending && setShowSave(false)} title={t('saveDialog')}>
      <form onSubmit={handleSave} className="space-y-3">
        <Field label={t('recipeId')}><Input name="id" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={40} defaultValue={draft.template?.builtin ? '' : draft.template?.id ?? ''} /></Field>
        <Field label={t('recipeTitle')}><Input name="title" required maxLength={80} defaultValue={draft.template?.title ?? ''} /></Field>
        <Field label={t('recipeDescription')}><Textarea name="description" maxLength={400} defaultValue={draft.template?.description ?? ''} /></Field>
        <Field label={t('recipeCategory')}><Select name="category" defaultValue={draft.template?.category ?? 'custom'}>{Object.entries(categoryLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select></Field>
        <p className="text-xs text-fg-muted">{t('saveHint')}</p>
        {actionError !== undefined && <ErrorBox error={actionError} />}
        <Button type="submit" loading={save.isPending} disabled={busy || !canWrite}>{tc('save')}</Button>
      </form>
    </Dialog>
  </div>;
}
