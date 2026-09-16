import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parse, stringify } from 'yaml';
import type { Template } from '@/server/store/types';
import {
  readEvaluationQuery, initializeWorkflowYaml, renderWorkflowYaml, credentialBindings,
  chooseCredential, assertRegisteredCredentials, workflowSubmissionPayload, savedTemplatePayload, assertEvaluationModel,
  NewWorkflowPage,
} from './NewWorkflowPage';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const template: Template = {
  id: 'mujoco-render', templateVersion: 7, title: 'MuJoCo', description: '', builtin: true, category: 'evaluation', createdAt: '',
  params: [
    { name: 'dataset_name', label: 'Dataset', type: 'string', default: 'old' },
    { name: 'checkpoint_bundle', label: 'Bundle', type: 'string', default: 'final' },
    { name: 'episodes', label: 'Episodes', type: 'number', default: '5' },
    { name: 'eval_seed', label: 'Seed', type: 'number', default: '1' },
  ],
  yaml: stringify({ workflow: { name: 'mujoco-render', resources: { cpu: { cpu: 2 } }, tasks: [
    { name: 'evaluate', resource: 'cpu', image: 'test-image', args: ['{{input:0}}/{{ checkpoint_bundle }}', '{{ episodes }}', '{{ eval_seed }}'], inputs: [{ dataset: { name: '{{ dataset_name }}', version: 1 } }] },
  ] }, 'default-values': { dataset_name: 'old', checkpoint_bundle: 'final', episodes: '5', eval_seed: '1' } }),
};
const query = () => new URLSearchParams('template=mujoco-render&model_id=mdl-one&dataset_name=trained&dataset_version=12&checkpoint_bundle=checkpoints/step-100&episodes=20&eval_seed=2042');

function credentialTemplate(): Template {
  return { ...template, id: 'train', params: [{ name: 'hf_token_param', label: 'HF', type: 'string', default: '/groot/unregistered' }],
    yaml: stringify({ workflow: { name: 'train', tasks: [{ name: 'train', credentials: { huggingface: { HF_TOKEN: '{{ hf_token_param }}' } } }],
      groups: [{ name: 'group', tasks: [{ name: 'worker', credentials: { ngc: { NGC_API_KEY: '/pai/implicit' } } }] }] }, 'default-values': { hf_token_param: '/groot/unregistered' } }) };
}

describe('workflow draft contracts', () => {
  it('applies the CPU quick preset to actual training/evaluation arguments without changing expert defaults', () => {
    const pipeline: Template = { ...template, id: 'mujoco-pipeline', params: [
      { name: 'total_steps', label: 'Steps', type: 'number', default: '200000' },
      { name: 'num_envs', label: 'Envs', type: 'number', default: '4' },
      { name: 'episodes', label: 'Episodes', type: 'number', default: '5' },
    ], yaml: stringify({ workflow: { name: 'mujoco-pipeline', tasks: [
      { name: 'train', args: ['--total-steps', '{{ total_steps }}', '--num-envs', '{{ num_envs }}'] },
      { name: 'evaluate', args: ['--episodes', '{{ episodes }}'], inputs: [{ task: 'train' }] },
    ] }, 'default-values': { total_steps: '200000', num_envs: '4', episodes: '5' } }) };
    const result = parse(renderWorkflowYaml(initializeWorkflowYaml(pipeline, undefined, 'cpu-quick')));
    expect(result.workflow.tasks[0].args).toEqual(['--total-steps', '512', '--num-envs', '1']);
    expect(result.workflow.tasks[1]).toEqual({ name: 'evaluate', args: ['--episodes', '20'], inputs: [{ task: 'train' }] });
    expect(parse(pipeline.yaml)['default-values']).toEqual({ total_steps: '200000', num_envs: '4', episodes: '5' });
    expect(() => initializeWorkflowYaml(template, undefined, 'cpu-quick')).toThrow();
  });
  it('pins evaluation dataset_version in the actual input and applies bundle/episode/seed inputs', () => {
    const link = readEvaluationQuery(query())!;
    const source = initializeWorkflowYaml(template, link);
    const rendered = parse(renderWorkflowYaml(source));
    expect(rendered.workflow.tasks[0].inputs[0].dataset).toEqual({ name: 'trained', version: 12 });
    expect(rendered.workflow.tasks[0].args).toEqual(['{{input:0}}/checkpoints/step-100', '20', '2042']);
    expect(rendered.workflow.labels.model_id).toBe('mdl-one');
    expect(rendered['default-values'].dataset_version).toBe('12');
  });
  it.each(['0', '-1', '1.5', 'latest'])('rejects a nonimmutable evaluation dataset version %s', (version) => {
    const params = query(); params.set('dataset_version', version);
    expect(() => readEvaluationQuery(params)).toThrow();
  });
  it('rejects incomplete, duplicate, or escaping evaluation query inputs', () => {
    const missing = query(); missing.delete('eval_seed'); expect(() => readEvaluationQuery(missing)).toThrow();
    const duplicate = query(); duplicate.append('dataset_version', '13'); expect(() => readEvaluationQuery(duplicate)).toThrow();
    const escaping = query(); escaping.set('checkpoint_bundle', '../other'); expect(() => readEvaluationQuery(escaping)).toThrow();
  });
  it('verifies the launch link against the registered model source and compatible template', () => {
    const link = readEvaluationQuery(query())!;
    const model = { id: 'mdl-one', source: { dataset: { name: 'trained', version: 12 } }, bundle: { path: 'checkpoints/step-100' }, evaluationLaunch: { template: 'mujoco-render' } };
    expect(() => assertEvaluationModel(link, model)).not.toThrow();
    expect(() => assertEvaluationModel(link, { ...model, source: { dataset: { name: 'trained', version: 1 } } })).toThrow();
    expect(() => initializeWorkflowYaml({ ...template, yaml: stringify({ workflow: { tasks: [] } }) }, link)).toThrow();
  });
  it('clears implicit credential defaults and grouped literal refs before selection', () => {
    const source = initializeWorkflowYaml(credentialTemplate());
    expect(parse(source)['default-values'].hf_token_param).toBe('');
    expect(credentialBindings(renderWorkflowYaml(source)).map((binding) => binding.ref)).toEqual(['', '']);
    expect(() => assertRegisteredCredentials(renderWorkflowYaml(source), [])).toThrow();
  });
  it('writes only selected metadata references and rejects unavailable/unregistered references', () => {
    let source = initializeWorkflowYaml(credentialTemplate());
    const refs = [{ ref: '/physical-ai/projects/p/users/hash/hf', status: 'READY' }, { ref: '/groot/registered', status: 'REGISTERED' }];
    const bindings = credentialBindings(source);
    source = chooseCredential(source, bindings[0].key, refs[0].ref);
    source = chooseCredential(source, bindings[1].key, refs[1].ref);
    const rendered = renderWorkflowYaml(source);
    expect(() => assertRegisteredCredentials(rendered, refs)).not.toThrow();
    expect(() => assertRegisteredCredentials(rendered, [{ ...refs[0], status: 'ERROR' }, refs[1]])).toThrow();
    expect(() => assertRegisteredCredentials(rendered, undefined)).toThrow();
    expect(credentialBindings(rendered).map((binding) => binding.ref)).toEqual(refs.map((ref) => ref.ref));
  });
  it('preserves YAML edits while safely rendering quoted/newline parameters and root priority', () => {
    const edited = parse(template.yaml);
    edited.workflow.tasks[0].args.push('--manual-override');
    edited.workflow.resources.cpu.memory = '16Gi';
    edited['default-values'].checkpoint_bundle = 'folder "quoted"\n$&';
    const rendered = parse(renderWorkflowYaml(stringify(edited), { namespace: 'hyperpod-ns-p', priority: 'research-high' }));
    expect(rendered.workflow.tasks[0].args).toContain('--manual-override');
    expect(rendered.workflow.tasks[0].args[0]).toBe('{{input:0}}/folder "quoted"\n$&');
    expect(rendered.workflow.resources.cpu.memory).toBe('16Gi');
    expect(rendered.workflow.priority).toBe('research-high');
    expect(rendered.workflow.tasks[0]).not.toHaveProperty('priority');
  });
  it('submits the selected immutable templateVersion with the edited YAML, never inventing revision 1', () => {
    const yaml = renderWorkflowYaml(template.yaml);
    expect(workflowSubmissionPayload(yaml, template, 'hyperpod-ns-p')).toEqual({ yaml, templateId: 'mujoco-render', templateVersion: 7, namespace: 'hyperpod-ns-p' });
    expect(() => workflowSubmissionPayload(yaml, { ...template, templateVersion: undefined }, 'hyperpod-ns-p')).toThrow();
    expect(workflowSubmissionPayload(yaml, undefined, 'hyperpod-ns-p')).toEqual({ yaml, namespace: 'hyperpod-ns-p' });
  });
  it('sends preflight acknowledgement only when explicitly given, preserving source revision and raw YAML submissions', () => {
    const yaml = renderWorkflowYaml(template.yaml);
    expect(workflowSubmissionPayload(yaml, template, 'hyperpod-ns-p', true)).toEqual({
      yaml, templateId: 'mujoco-render', templateVersion: 7, namespace: 'hyperpod-ns-p', acknowledgePreflight: true,
    });
    expect(workflowSubmissionPayload(yaml, undefined, undefined, true)).toEqual({ yaml, acknowledgePreflight: true });
    expect(workflowSubmissionPayload(yaml, template, undefined, false)).not.toHaveProperty('acknowledgePreflight');
    expect(workflowSubmissionPayload(yaml, template)).not.toHaveProperty('acknowledgePreflight');
  });
  it('saves parameterized YAML with current defaults and baseVersion for immutable custom-template updates', () => {
    const source = parse(template.yaml); source['default-values'].episodes = '30';
    const body = savedTemplatePayload(stringify(source), { ...template, builtin: false }, { id: 'mujoco-render', title: 'Evaluation', description: '', category: 'evaluation' });
    expect(body.baseVersion).toBe(7);
    expect(body.yaml).toContain('{{ episodes }}');
    expect(body.params.find((param) => param.name === 'episodes')?.default).toBe('30');
  });
  it('routes full GR00T discovery to the native pipeline and hides the incompatible old catalog entry', () => {
    const client = new QueryClient();
    client.setQueryData(['api', '/api/templates'], [template, { ...template, id: 'gr00t-pipeline', title: 'Legacy EKS pipeline' }]);
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(NewWorkflowPage)));
    expect(html).toContain('href="/pipelines"');
    expect(html).toContain('GR00T 전체 파이프라인');
    expect(html).not.toContain('Legacy EKS pipeline');
    expect(() => workflowSubmissionPayload(template.yaml, { ...template, id: 'gr00t-pipeline' })).toThrow();
    client.clear();
  });
});
