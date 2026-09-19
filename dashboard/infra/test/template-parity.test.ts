import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { synthesize } from './helpers/synth';
import { canonical } from './helpers/canonical';

/**
 * The default stack must synthesize to the SAME template as the pre-split
 * construct (base commit 963e4ab), so `cdk deploy` replaces or mutates nothing.
 *
 * The fixture `fixtures/default-template.json` was generated from 963e4ab via a
 * `git worktree` and the same `canonical()` normalisation. `canonical` sorts object
 * keys (the Resources map is unordered in CloudFormation, and the split changed
 * construct-creation order) but PRESERVES array order — so a container `Environment`
 * reorder, which would force a task-definition revision and redeploy, fails here.
 */
test('default stack synthesizes to the pre-split template (no resource replacement/redeploy)', () => {
  const expected = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/default-template.json'), 'utf8'));
  const actual = canonical(synthesize().toJSON());
  assert.deepEqual(actual, expected);
});
