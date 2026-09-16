import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { cloneWorkflowYaml } from './clone';

describe('clone submitted workflow', () => {
  it('retains the submitted spec and materializes recorded overrides as defaults', () => {
    const yaml = 'workflow:\n  name: original\n  tasks:\n    - name: train\n      args: ["{{ seed }}", "{{output}}"]\ndefault-values:\n  seed: 42\n  steps: 100\n';
    const cloned = parse(cloneWorkflowYaml(yaml, { seed: '7', steps: '250' }));
    expect(cloned.workflow).toEqual(parse(yaml).workflow);
    expect(cloned['default-values']).toEqual({ seed: '7', steps: '250' });
  });
});
