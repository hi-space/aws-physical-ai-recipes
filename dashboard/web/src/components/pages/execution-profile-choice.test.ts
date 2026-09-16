import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { chooseExecutionProfile } from './NewWorkflowPage';
it('binds only the selected task and preserves source defaults, commands and group members', () => {
  const yaml = `workflow:
  name: devices
  tasks:
    - {name: prepare, image: app, command: [true]}
  groups:
    - name: robots
      tasks:
        - {name: receive, image: app, command: [receive]}
        - {name: control, image: app, command: [control]}
default-values: {seed: 42}
`;
  const changed = parse(chooseExecutionProfile(yaml, 'control', { id: 'approved-device', version: 3 }));
  expect(changed.workflow.groups[0].tasks[1].executionProfile).toEqual({ id: 'approved-device', version: 3 });
  expect(changed.workflow.groups[0].tasks[0].executionProfile).toBeUndefined();
  expect(changed.workflow.tasks[0].executionProfile).toBeUndefined();
  expect(changed['default-values']).toEqual({ seed: 42 });
  expect(parse(chooseExecutionProfile(JSON.stringify(changed), 'control')).workflow.groups[0].tasks[1].executionProfile).toBeUndefined();
});
