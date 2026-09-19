import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logicalIds, synthesize } from './helpers/synth';

// Additions are safe (a new resource); deletions/replacements are not (they churn the deployed stack).
// New logical ids must be justified here, id-by-id, rather than silently regenerating the fixture.
//   - AuthUserPoolAppClient…: sub-project E adds the secret-less 'app' Cognito client (both ingress modes).
const ALLOWED_NEW_IDS: RegExp[] = [/^AuthUserPoolAppClient/];

test('default modules keep every CloudFormation logical id of the deployed stack', () => {
  const expected = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/default-logical-ids.json'), 'utf8')) as string[];
  const actual = logicalIds(synthesize());
  const added = actual.filter(id => !expected.includes(id));
  assert.deepEqual(added.filter(id => !ALLOWED_NEW_IDS.some(re => re.test(id))), [], 'unexpected new logical ids (not in the ALLOWED_NEW_IDS allow-list)');
  assert.deepEqual(expected.filter(id => !actual.includes(id)), [], 'missing logical ids (resource would be replaced or deleted)');
});
