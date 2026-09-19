import { describe, it, expect } from 'vitest';
import { parseWorkflowYaml, substitute } from './template';

describe('version coercion', () => {
  it('coerces numeric string version to number when substituted', () => {
    const yaml = `
workflow:
  name: test-wf
  resources:
    default: { cpu: 1, memory: 1Gi }
  tasks:
    - name: test
      image: img
      command: ['echo']
      inputs:
        - dataset:
            name: my-data
            version: "{{ dataset_version }}"
default-values:
  dataset_version: '1'
`;
    const parsed = parseWorkflowYaml(yaml);
    const inputs = parsed.spec.workflow.tasks[0].inputs as { dataset: { version: number } }[];
    expect(inputs[0].dataset.version).toBe(1);
  });

  it('keeps numeric strings as-is in non-version contexts', () => {
    const yaml = `
workflow:
  name: test-wf
  resources:
    default: { cpu: 1, memory: 1Gi }
  tasks:
    - name: test
      image: img
      command: ['echo']
      args: ['{{ num_envs }}']
default-values:
  num_envs: '4'
`;
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.spec.workflow.tasks[0].args?.[0]).toBe('4');
  });

  it('keeps a non-digit _version value quoted as-is, without stripping quotes', () => {
    expect(substitute('version: "{{ dataset_version }}"', { dataset_version: 'v1' })).toBe('version: "v1"');
  });

  it('keeps an empty _version value quoted as-is, without stripping quotes', () => {
    expect(substitute('version: "{{ dataset_version }}"', { dataset_version: '' })).toBe('version: ""');
  });
});

describe('substitute quoting safety', () => {
  it('does not corrupt a quoted scalar where the placeholder has trailing text', () => {
    expect(substitute('x: "{{ foo }}-bar"', { foo: 'v' })).toBe('x: "v-bar"');
  });

  it('does not corrupt a quoted scalar where the placeholder has leading text', () => {
    expect(substitute('x: "prefix-{{ foo }}"', { foo: 'v' })).toBe('x: "prefix-v"');
  });

  it('substitutes a whole single-quoted scalar and preserves the quotes', () => {
    expect(substitute("x: '{{ foo }}'", { foo: 'v' })).toBe("x: 'v'");
  });

  it('does not coerce a _version field with trailing text even if numeric', () => {
    expect(substitute('x: "{{ dataset_version }}-final"', { dataset_version: '1' })).toBe('x: "1-final"');
  });
});
