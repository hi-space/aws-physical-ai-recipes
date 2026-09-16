'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { parseDocument } from 'yaml';
import { Badge, Button, Card, CodeBlock, Dialog, EmptyState, ErrorBox, Field, Input, LinkButton, Select, Spinner, Textarea } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { api, ApiError, can, useApi, useApiMutation, useMe } from '@/lib/api-client';
import type { Template, TemplateParam } from '@/server/store/types';

type Mapping = Record<string, unknown>;
type YamlPath = (string | number)[];
const mapping = (value: unknown): value is Mapping => value !== null && typeof value === 'object' && !Array.isArray(value);
const variable = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const reserved = new Set(['output', 'workflow_id', 'task_name', 'replica_index', 'input', 'host']);
const validVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const categoryLabels = { setup: '환경 준비', data: '데이터 준비', training: '학습', evaluation: '평가', simulation: '시뮬레이션', custom: '사용자 레시피' };
const paramLabels: Record<string, string> = { image: '실행 이미지', dataset_name: '입력 데이터셋', checkpoint_bundle: '체크포인트 묶음 경로', episodes: '평가 에피소드 수', eval_seed: '평가 seed', seed: '학습 seed', total_steps: '학습 step 수', num_envs: '병렬 환경 수', checkpoint_every: '체크포인트 저장 주기', resume: '재개할 체크포인트' };

export interface EvaluationLink { templateId: string; modelId: string; datasetName: string; datasetVersion: number; checkpointBundle: string; episodes: string; evalSeed: string }
interface EvaluationModel { id: string; source: { dataset: { name: string; version: number } }; bundle?: { path: string }; evaluationLaunch?: { template: string }; evaluationUnavailableReason?: string }
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
  if (document.errors.length) throw new Error('YAML 문법을 확인하세요. 편집 내용은 유지됩니다.');
  const root: unknown = document.toJS({ maxAliasCount: 50 });
  if (!mapping(root) || !mapping(root.workflow)) throw new Error('workflow 객체가 있는 YAML을 입력하세요.');
  return { document, root, workflow: root.workflow };
}
function defaultsOf(yaml: string): Record<string, string> {
  const defaults = documentOf(yaml).root['default-values'];
  if (defaults !== undefined && !mapping(defaults)) throw new Error('default-values는 이름과 값의 매핑이어야 합니다.');
  return Object.fromEntries(Object.entries(defaults ?? {}).map(([name, value]) => {
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`파라미터 ${name}의 값을 확인하세요.`);
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
export function credentialBindings(yaml: string): CredentialBinding[] {
  const { root } = documentOf(yaml);
  return tasksOf(root).flatMap(({ task, path }) => {
    if (!mapping(task.credentials)) return [];
    return Object.entries(task.credentials).flatMap(([group, values]) => !mapping(values) ? [] : Object.entries(values).map(([environment, value]) => {
      const ref = typeof value === 'string' ? value : '';
      const location = [...path, 'credentials', group, environment];
      return { key: JSON.stringify(location), path: location, label: `${String(task.name ?? '작업')} · ${environment}`, ref, parameter: variable.exec(ref)?.[1] };
    }));
  });
}
export function readEvaluationQuery(query: URLSearchParams): EvaluationLink | undefined {
  if (!query.has('model_id')) return undefined;
  const read = (key: string) => {
    const values = query.getAll(key);
    if (values.length !== 1 || !values[0]) throw new Error(`모델 평가 링크의 ${key} 입력을 확인하세요.`);
    return values[0];
  };
  const templateId = read('template'), modelId = read('model_id'), datasetName = read('dataset_name');
  if (!/^[a-z0-9-]{1,40}$/.test(templateId) || !/^[a-z0-9-]{1,100}$/.test(modelId) || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(datasetName)) throw new Error('모델 평가 링크의 식별자가 올바르지 않습니다.');
  const version = read('dataset_version'), episodes = read('episodes'), evalSeed = read('eval_seed'), checkpointBundle = read('checkpoint_bundle');
  if (!/^[1-9][0-9]*$/.test(version) || !validVersion(Number(version))) throw new Error('평가 데이터셋 버전은 양의 정수여야 합니다.');
  if (!/^[1-9][0-9]*$/.test(episodes) || Number(episodes) > 100000 || !/^[0-9]+$/.test(evalSeed) || Number(evalSeed) > 4294967295) throw new Error('평가 에피소드 수와 seed를 확인하세요.');
  if (checkpointBundle.length > 2048 || /[\\\x00-\x1f]/.test(checkpointBundle) || checkpointBundle.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('체크포인트 묶음은 데이터셋 안의 상대 경로여야 합니다.');
  return { templateId, modelId, datasetName, datasetVersion: Number(version), checkpointBundle, episodes, evalSeed };
}
export function assertEvaluationModel(link: EvaluationLink, model: EvaluationModel) {
  if (model?.id !== link.modelId || model.evaluationLaunch?.template !== link.templateId || model.source?.dataset.name !== link.datasetName ||
    model.source.dataset.version !== link.datasetVersion || model.bundle?.path !== link.checkpointBundle) throw new Error('평가 링크가 등록 모델의 고정된 데이터셋·체크포인트와 일치하지 않습니다. 모델 화면에서 다시 시작하세요.');
}
function replaceVariables(value: string, variables: Record<string, string>) {
  return value.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?::([^}]+))?\s*\}\}/g, (match, name: string, suffix?: string) => {
    if (reserved.has(name) || suffix !== undefined) return match;
    if (!Object.hasOwn(variables, name)) throw new Error(`파라미터 ${name}의 값이 없습니다.`);
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
    if (template.id !== link.templateId || !['dataset_name', 'checkpoint_bundle', 'episodes', 'eval_seed'].every((name) => template.params.some((param) => param.name === name))) throw new Error('선택한 레시피는 이 모델의 평가 입력을 지원하지 않습니다.');
    Object.assign(defaults, { dataset_name: link.datasetName, dataset_version: String(link.datasetVersion), checkpoint_bundle: link.checkpointBundle, episodes: link.episodes, eval_seed: link.evalSeed, model_id: link.modelId });
    let bound = 0;
    for (const { task, path } of tasksOf(document.toJS({ maxAliasCount: 50 }) as Mapping)) {
      if (Array.isArray(task.inputs)) task.inputs.forEach((input, index) => {
        if (mapping(input) && mapping(input.dataset) && typeof input.dataset.name === 'string' && replaceVariables(input.dataset.name, defaults) === link.datasetName) {
          document.setIn([...path, 'inputs', index, 'dataset', 'version'], link.datasetVersion); bound++;
        }
      });
    }
    if (!bound) throw new Error('레시피에 모델 데이터셋을 연결할 입력이 없습니다.');
    document.setIn(['workflow', 'labels', 'model_id'], link.modelId);
  }
  if (preset === 'cpu-quick') {
    if (link || template.id !== 'mujoco-pipeline' || !Object.keys(cpuQuickDefaults).every(name => template.params.some(param => param.name === name))) {
      throw new Error('이 레시피 버전은 CPU 빠른 시작 설정을 지원하지 않습니다.');
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
  if (!binding) throw new Error('자격증명 입력이 변경되었습니다. YAML을 확인하세요.');
  const { document } = documentOf(yaml);
  document.setIn(binding.parameter ? ['default-values', binding.parameter] : binding.path, ref);
  return document.toString({ lineWidth: 0 });
}
export function assertRegisteredCredentials(yaml: string, credentials: CredentialOption[] | undefined) {
  const bindings = credentialBindings(yaml);
  if (!bindings.length) return;
  if (!credentials) throw new Error('자격증명 목록을 확인한 뒤 실행할 수 있습니다.');
  const allowed = new Set(credentials.filter((credential) => ['READY', 'REGISTERED'].includes(credential.status)).map((credential) => credential.ref));
  if (bindings.some((binding) => !binding.ref || !allowed.has(binding.ref))) throw new Error('모든 자격증명 입력에서 사용 가능한 등록 참조를 선택하세요. 비밀값을 직접 입력하지 마세요.');
}
export function workflowSubmissionPayload(yaml: string, template?: Template, namespace?: string, acknowledgePreflight = false) {
  if (template?.id === 'gr00t-pipeline') throw new Error('이전 GR00T EKS 레시피는 지원하지 않습니다. GR00T 전체 파이프라인을 사용하세요.');
  if (template && !validVersion(template.templateVersion)) throw new Error('게시된 레시피 버전이 확인되지 않았습니다. 버전 API가 준비된 뒤 다시 시도하세요.');
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
  if (id === 'gr00t-pipeline') throw new Error('이전 GR00T EKS 레시피는 보관되었습니다. GR00T 전체 파이프라인을 사용하세요.');
  if (query.getAll('template').length !== 1 || !/^[a-z0-9-]{1,40}$/.test(id)) throw new Error('레시피 선택 링크를 확인하세요.');
  const version = query.get('templateVersion');
  if (version !== null && (query.getAll('templateVersion').length !== 1 || !/^[1-9][0-9]*$/.test(version) || !validVersion(Number(version)))) throw new Error('레시피 버전은 양의 정수여야 합니다.');
  const preset = query.get('preset');
  if (preset !== null && (query.getAll('preset').length !== 1 || preset !== 'cpu-quick' || id !== 'mujoco-pipeline')) throw new Error('지원하지 않는 빠른 시작 설정입니다.');
  return { id, ...(version ? { version: Number(version) } : {}), ...(preset === 'cpu-quick' ? { preset: 'cpu-quick' as const } : {}) };
}
function assertEvaluationDraft(yaml: string, link: EvaluationLink) {
  const { root } = documentOf(yaml);
  const inputs = tasksOf(root).flatMap(({ task }) => Array.isArray(task.inputs) ? task.inputs : []).filter((input) => mapping(input) && mapping(input.dataset) && input.dataset.name === link.datasetName);
  const defaults = defaultsOf(yaml);
  if (!inputs.length || inputs.some((input) => (input as { dataset: { version: unknown } }).dataset.version !== link.datasetVersion) || defaults.checkpoint_bundle !== link.checkpointBundle || defaults.dataset_name !== link.datasetName) throw new Error('연결된 모델의 데이터셋 버전과 체크포인트 경로를 유지하세요. 다른 입력은 모델 연결을 해제한 뒤 편집할 수 있습니다.');
}

export function NewWorkflowPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const query = useMemo(() => {
    try { const params = new URLSearchParams(search); return { selection: selectionFromQuery(params), evaluation: readEvaluationQuery(params), error: undefined }; }
    catch (error) { return { selection: null, evaluation: undefined, error }; }
  }, [search]);
  const me = useMe();
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
      if (!templateReady) throw new Error('고정된 레시피 버전을 불러오는 중입니다.');
      if (evaluation) {
        if (!model.data || model.error) throw new Error('등록 모델을 확인한 뒤 평가할 수 있습니다.');
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
        if (!abort.signal.aborted) setValidation({ inputKey: validationKey, result: { ok: false, error: error instanceof Error ? error.message : '실행 구성을 검증하지 못했습니다.' } });
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
      if (!id) throw new Error('실행 ID를 받지 못했습니다. 실행 목록을 확인하세요.');
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
      if (!validVersion(result.templateVersion)) throw new Error('저장 응답에 버전 정보가 없습니다. 레시피 목록을 확인하세요.');
      setShowSave(false); setNotice(`${result.id} v${result.templateVersion}을 저장했습니다.`);
    } catch (error) { setActionError(error); }
  }
  function downloadYaml() {
    const url = URL.createObjectURL(new Blob([derived.rendered || draft.yaml], { type: 'text/yaml' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'workflow.yaml'; anchor.click(); URL.revokeObjectURL(url);
  }

  return <div className="space-y-5">
    <PageHeader title="새 워크플로" description="레시피 버전과 입력을 확인한 뒤 실행하세요. YAML 직접 편집 내용도 실행에 반영됩니다."
      actions={<LinkButton href="/pipelines">GR00T 전체 파이프라인</LinkButton>} />
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton href="/workflows/new?template=mujoco-pipeline&preset=cpu-quick" variant="primary">CPU 학습 → 평가 시작</LinkButton>
      <p className="text-xs text-fg-muted">512 steps · 환경 1개 · 평가 20회. 설정 확인 후 실행하는 짧은 동작 확인용이며, 학습 품질을 보장하지 않습니다.</p>
    </div>
    {actionError !== undefined && <ErrorBox error={actionError} />}
    {query.error !== undefined && <ErrorBox error={query.error} />}
    {me.error && <ErrorBox error={me.error} />}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {evaluation && <Card title="등록 모델 평가" description={`${evaluation.modelId} · ${evaluation.datasetName} v${evaluation.datasetVersion} · ${evaluation.checkpointBundle}`} actions={<Button size="sm" variant="ghost" onClick={disconnectModel} disabled={busy}>모델 연결 해제</Button>}>
      {model.isLoading && <Spinner label="등록 모델을 확인하는 중…" />}{model.error && <ErrorBox error={model.error} />}
      <p className="text-xs text-fg-muted">데이터셋 입력은 등록 모델의 고정 버전에 연결됩니다. 에피소드 수와 평가 seed는 변경할 수 있습니다.</p>
    </Card>}
    <nav aria-label="워크플로 작성 단계" className="grid grid-cols-3 gap-3">{['레시피 선택', '입력 설정', 'YAML 및 실행'].map((label, index) => <button key={label} type="button" aria-current={step === index + 1 ? 'step' : undefined} onClick={() => setStep(index + 1)} className={`rounded border p-3 text-left ${step === index + 1 ? 'border-accent bg-accent/10' : 'border-border'}`}><span className="text-xs">{index + 1}단계</span><span className="block text-sm">{label}</span></button>)}</nav>
    {step === 1 && <div className="space-y-4">
      {templates.error && <ErrorBox error={templates.error} />}{templates.isLoading && <Spinner label="레시피를 불러오는 중…" />}
      {!templates.isLoading && !templates.error && !templates.data?.length && <EmptyState title="사용 가능한 레시피가 없습니다." />}
      {templateGroups.map((group) => group.templates.length > 0 && <section key={group.id} aria-label={group.label}>
        <h2 className="text-sm font-semibold mb-2">{group.label}</h2>
        <div className="grid gap-3 md:grid-cols-2">{group.templates.map((template) => <button key={template.id} type="button" aria-pressed={selection?.id === template.id} onClick={() => {
          if (evaluation && evaluation.templateId !== template.id) setDetached(true);
          setSelection({ id: template.id, version: validVersion(template.templateVersion) ? template.templateVersion : undefined }); setDraft({ yaml: '' }); setStep(2); setActionError(undefined);
        }} className="rounded border border-border p-4 text-left hover:bg-bg-elev-2 focus-visible:outline focus-visible:outline-accent">
          <span className="font-semibold text-sm">{template.title}</span> <Badge>{validVersion(template.templateVersion) ? `v${template.templateVersion}` : '버전 확인 필요'}</Badge>
          <span className="block text-xs text-fg-muted mt-2">{template.description}</span>
          <span className="flex gap-1 mt-2">{template.requires?.map((requirement) => <Badge key={requirement}>{requirement}</Badge>)}</span>
        </button>)}</div>
      </section>)}
      <Button variant="ghost" disabled={busy} onClick={() => {
        // Editing a selected recipe retains its immutable source revision and model binding.
        if (!draft.template) setSelection(null);
        setStep(3);
      }}>YAML 직접 입력</Button>
    </div>}
    {selection && (step === 2 || step === 3) && <Card title={draft.template?.title ?? selection.id} description="선택한 레시피 버전은 작성 중에 자동으로 최신 버전으로 바뀌지 않습니다.">
      {templateDetail.error && <ErrorBox error={templateDetail.error} />}
      {!templateReady && <p role="status" className="text-sm">{templateDetail.isFetching ? '레시피 버전을 확인하는 중…' : '게시된 레시피 버전이 확인되지 않았습니다. 버전 API가 준비되면 다시 선택하세요.'}</p>}
      {templateDetail.data && selection.version && templateDetail.data.templateVersion !== selection.version && <ErrorBox error={{ message: '요청한 레시피 버전과 응답이 다릅니다. 실행할 수 없습니다.' }} />}
      {versions.length > 0 && <Field label="레시피 버전"><Select id="template-version" value={selection.version ?? ''} disabled={busy} onChange={(event) => { setSelection({ ...selection, version: Number(event.target.value) }); setDraft({ yaml: '' }); setActionError(undefined); }}>
        {versions.map((version) => <option key={version.templateVersion} value={version.templateVersion}>v{version.templateVersion}</option>)}
      </Select></Field>}
      {history.error && <ErrorBox error={history.error} />}
    </Card>}
    {step === 2 && <div className="space-y-4">
      {!selection && !draft.yaml && <EmptyState title="레시피를 선택하거나 YAML을 직접 입력하세요." />}
      {templateReady && draft.template?.params.filter((param) => !credentialParams.has(param.name)).map((param) => {
        const value = derived.defaults[param.name] ?? ''; const locked = !!evaluation && ['dataset_name', 'checkpoint_bundle'].includes(param.name);
        return <Field key={param.name} label={paramLabels[param.name] ?? param.label} help={locked ? '등록 모델에 고정된 입력입니다.' : param.help}>
          {param.type === 'boolean' ? <input id={`param-${param.name}`} type="checkbox" checked={value === 'true'} disabled={busy || locked} onChange={(event) => editDefault(param.name, String(event.target.checked))} />
            : param.type === 'select' ? <Select id={`param-${param.name}`} value={value} disabled={busy || locked} onChange={(event) => editDefault(param.name, event.target.value)}>{param.options?.map((option) => <option key={option} value={option}>{option}</option>)}</Select>
            : param.type === 'text' ? <Textarea id={`param-${param.name}`} value={value} readOnly={locked} disabled={busy} onChange={(event) => editDefault(param.name, event.target.value)} />
            : <Input id={`param-${param.name}`} type={param.type === 'number' ? 'number' : 'text'} step={param.type === 'number' ? 'any' : undefined} value={value} readOnly={locked} disabled={busy} onChange={(event) => editDefault(param.name, event.target.value)} />}
        </Field>;
      })}
      {derived.bindings.length > 0 && <Card title="자격증명 연결" description="등록된 참조만 선택합니다. 이 화면은 비밀값을 읽거나 표시하지 않습니다.">
        {credentials.error && <ErrorBox error={credentials.error} />}{credentials.isLoading && <Spinner label="자격증명 참조를 불러오는 중…" />}
        {derived.bindings.map((binding) => <Field key={binding.key} label={binding.label}>
          <Select value={binding.parameter ? derived.defaults[binding.parameter] ?? '' : binding.ref} disabled={busy || credentials.isLoading || !!credentials.error} onChange={(event) => {
            try { setDraft((previous) => ({ ...previous, yaml: chooseCredential(previous.yaml, binding.key, event.target.value) })); setActionError(undefined); } catch (error) { setActionError(error); }
          }}><option value="">등록된 자격증명을 선택하세요</option>{readyCredentials.map((credential) => <option key={credential.ref} value={credential.ref}>{credential.name ?? credential.ref} · {credential.kind ?? 'generic'} · {credential.scope === 'project' ? '프로젝트 공유' : '비공개'}</option>)}</Select>
        </Field>)}
        {!credentials.isLoading && !credentials.error && !readyCredentials.length && <p className="text-xs text-fg-muted">사용 가능한 자격증명이 없습니다.</p>}
        <LinkButton href="/access" size="sm">자격증명 관리</LinkButton>
      </Card>}
      <Field label="실행 네임스페이스" help="현재 선택한 프로젝트가 실행 위치와 큐를 결정합니다."><Input readOnly value={me.data?.defaultNamespace ?? ''} /></Field>
      {queues.error && <ErrorBox error={queues.error} />}
      {!!queues.data?.priorityClasses.length && <Field label="우선순위"><Select value={priority ?? ''} onChange={(event) => setPriority(event.target.value)}><option value="">기본값</option>{queues.data.priorityClasses.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</Select></Field>}
      {preflightError !== undefined && <ErrorBox error={preflightError} />}
      <Button onClick={() => setStep(3)}>YAML 확인</Button>
    </div>}
    {step === 3 && <div className="space-y-4">
      <Field label="워크플로 YAML" help="직접 편집 내용과 선택한 원본 버전을 유지합니다. 파라미터는 default-values에서 변경할 수 있으며, 비밀값 대신 등록된 자격증명 참조를 사용하세요."><Textarea id="workflow-yaml" value={draft.yaml} rows={24} maxLength={1024 * 1024} disabled={busy} className="font-mono text-xs" onChange={(event) => { setDraft((previous) => ({ ...previous, yaml: event.target.value })); setPriority(undefined); }} /></Field>
      {preflightError !== undefined && <ErrorBox error={preflightError} />}
      {derived.rendered && <details><summary className="cursor-pointer text-sm">실제로 제출할 YAML 미리보기</summary><CodeBlock code={derived.rendered} lang="yaml" /></details>}
      {currentValidation ? currentValidation.result.ok ? <p role="status" className="text-sm text-ok">구성 검증 통과 · 작업 {currentValidation.result.tasks?.length ?? 0}개 · {currentValidation.result.order?.join(' → ')}</p>
        : <ErrorBox error={{ message: currentValidation.result.error ?? '실행 구성이 유효하지 않습니다.', details: currentValidation.result.details }} />
        : derived.rendered && !preflightError && <p role="status" className="text-sm text-fg-muted">실행 구성을 검증하는 중…</p>}
      {imagePreflight && <Card title="이미지 및 실행 환경 사전 점검"
        description={imagePreflight.status === 'blocked' ? '실행이 차단되었습니다. 아래 항목을 해결한 뒤 다시 점검하세요.' : '실행 전에 아래 항목을 검토하세요. 동의는 실행 성공이나 학습 품질을 보장하지 않습니다.'}
        actions={<Button size="sm" variant="ghost" disabled={busy} onClick={recheckPreflight}>사전 점검 다시 확인</Button>}>
        <ul className="space-y-2 text-sm" aria-label="사전 점검 항목">{imagePreflight.findings.map((finding, index) => <li key={`${finding.task ?? ''}:${finding.code}:${index}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{({ error: '오류', warning: '주의', unknown: '확인 필요' })[finding.severity] ?? '확인 필요'}</Badge>
            {finding.task && <span>작업: {finding.task}</span>}<code className="text-xs text-fg-muted">{finding.code}</code>
          </div>
          <p className="mt-1">{finding.message}</p>
        </li>)}</ul>
        {imagePreflight.status === 'needs-review' && <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={acknowledgedPreflight} disabled={!validated || busy} onChange={(event) => setReviewedValidation(event.target.checked ? currentValidation : undefined)} />
          <span>사전 점검 결과와 확인이 필요한 사항을 검토했으며, 이 설정으로 실행하는 데 동의합니다.</span>
        </label>}
      </Card>}
      {!canWrite && <p className="text-sm text-fg-muted">실행 권한이 있는 프로젝트를 선택하세요.</p>}
      <div className="flex flex-wrap gap-2"><Button variant="primary" onClick={handleSubmit} disabled={!validated || !preflightAllowed || !canWrite || busy} loading={submit.isPending}>워크플로 실행</Button>
        <Button variant="ghost" onClick={() => setShowSave(true)} disabled={!draft.yaml || !!preflightError || !canWrite || busy}>레시피로 저장</Button>
        <Button variant="ghost" onClick={downloadYaml} disabled={!draft.yaml}>YAML 다운로드</Button><Button variant="ghost" onClick={() => setStep(2)}>입력 설정으로</Button>
      </div>
    </div>}
    <Dialog open={showSave} onClose={() => !save.isPending && setShowSave(false)} title="레시피 저장">
      <form onSubmit={handleSave} className="space-y-3">
        <Field label="레시피 ID"><Input name="id" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={40} defaultValue={draft.template?.builtin ? '' : draft.template?.id ?? ''} /></Field>
        <Field label="제목"><Input name="title" required maxLength={80} defaultValue={draft.template?.title ?? ''} /></Field>
        <Field label="설명"><Textarea name="description" maxLength={400} defaultValue={draft.template?.description ?? ''} /></Field>
        <Field label="분류"><Select name="category" defaultValue={draft.template?.category ?? 'custom'}>{Object.entries(categoryLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select></Field>
        <p className="text-xs text-fg-muted">같은 사용자 레시피 ID로 저장하면 선택한 버전을 기준으로 새 버전을 만듭니다. 이전 버전은 유지됩니다.</p>
        {actionError !== undefined && <ErrorBox error={actionError} />}
        <Button type="submit" loading={save.isPending} disabled={busy || !canWrite}>저장</Button>
      </form>
    </Dialog>
  </div>;
}
