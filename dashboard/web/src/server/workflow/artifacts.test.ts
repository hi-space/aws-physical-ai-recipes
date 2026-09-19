import { expect, it } from 'vitest';
import type { Workflow } from '../store/types';
import { outputKindTag } from './artifacts';

function wf(specYaml: string, id = 'wf-1'): Workflow {
  return { id, specYaml } as Workflow;
}

const specWithPorts = `
workflow:
  name: hf-import
ui:
  recipe:
    ports:
      outputs:
        - name: hf-import
          kind: lerobot-dataset
          label: Imported dataset
`;

it('tags a published dataset with kind:<PortKind> when its name prefix matches a recipe output', () => {
  expect(outputKindTag(wf(specWithPorts), 'hf-import-wf-1')).toEqual(['kind:lerobot-dataset']);
});

it('adds no tag when the dataset name does not end with -<workflowId>', () => {
  expect(outputKindTag(wf(specWithPorts), 'hf-import-some-other-workflow')).toEqual([]);
});

it('adds no tag when the prefix does not match any declared recipe output', () => {
  expect(outputKindTag(wf(specWithPorts), 'unrelated-name-wf-1')).toEqual([]);
});

it('adds no tag for a custom recipe with no ui.recipe.ports metadata', () => {
  expect(outputKindTag(wf('workflow:\n  name: custom\n'), 'custom-out-wf-1')).toEqual([]);
});

it('never throws on unparseable spec YAML; it just omits the tag', () => {
  expect(outputKindTag(wf(': not: valid: yaml: at: all:'), 'x-wf-1')).toEqual([]);
});
