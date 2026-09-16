import YAML from 'yaml';
import { test as researcherTest, expect, requireCondition } from './researcher-helpers/fixture';
import type { CPUWorkflow } from './researcher-helpers/workflows';

// Separate second-release gate: the first-release researcher suite is unchanged.
const test = researcherTest.extend<{ checkpointRelease: void }>({
  checkpointRelease: [async ({}, use) => {
    requireCondition(process.env.DASHBOARD_CHECKPOINT_RECOVERY_LIVE === '1',
      'Checkpoint recovery live test requires explicit second-release deployment confirmation');
    await use();
  }, { auto: true }],
});
test.use({ ignoreHTTPSErrors: false, trace: 'off', screenshot: 'off', video: 'off' });
test.setTimeout(30 * 60_000);
test.describe.configure({ retries: 0 });

test('RESCHEDULE restores committed MuJoCo optimizer and normalization into attempt two', async ({ researcher }, info) => {
  const image = process.env.DASHBOARD_E2E_MUJOCO_IMAGE;
  requireCondition(image && !image.startsWith('required://'), 'DASHBOARD_E2E_MUJOCO_IMAGE must contain the updated second-release recipes');
  const name = `e2e-recover-${researcher.tag}`;
  const dataset = `e2e-recovered-${researcher.tag}`;
  const script = `
import json, os, pathlib, pickle, subprocess, sys
import numpy as np
import torch
from stable_baselines3 import PPO
output = pathlib.Path(os.environ["PAI_OUTPUT_DIR"])
attempt = int(os.environ["PAI_ATTEMPT"])
assert attempt in (1, 2), "unexpected retry attempt"
subprocess.run([sys.executable, "/opt/recipes/mujoco/train.py",
    "--output-dir", str(output), "--total-steps", "128" if attempt == 1 else "64",
    "--num-envs", "2", "--n-steps", "32", "--batch-size", "32",
    "--checkpoint-every", "64", "--eval-episodes", "1", "--seed", "7"], check=True)
if attempt == 1:
    raise SystemExit(75)
mapping = json.loads(os.environ["PAI_RESUME_CHECKPOINTS"])
restored = pathlib.Path(mapping[str(output)])
receipt = json.loads((restored / ".pai-restore-receipt.json").read_text())
assert receipt["source"]["attempt"] == 1 and receipt["target"]["attempt"] == 2
before = PPO.load(restored / "final/model.zip", device="cpu")
initial = PPO.load(output / "initial/model.zip", device="cpu")
after = PPO.load(output / "final/model.zip", device="cpu")
assert before.num_timesteps == initial.num_timesteps == 128 and after.num_timesteps == 192
assert initial._n_updates == before._n_updates > 0 and after._n_updates > before._n_updates
for key, value in before.policy.state_dict().items():
    assert torch.equal(value, initial.policy.state_dict()[key]), key
old, new = before.policy.optimizer.state_dict(), initial.policy.optimizer.state_dict()
assert old["param_groups"] == new["param_groups"] and old["state"]
for parameter, values in old["state"].items():
    for key, value in values.items():
        recovered = new["state"][parameter][key]
        assert torch.equal(value, recovered) if torch.is_tensor(value) else value == recovered
with (restored / "final/vecnormalize.pkl").open("rb") as file:
    old_stats = pickle.load(file)
with (output / "initial/vecnormalize.pkl").open("rb") as file:
    new_stats = pickle.load(file)
np.testing.assert_array_equal(old_stats.obs_rms.mean, new_stats.obs_rms.mean)
np.testing.assert_array_equal(old_stats.obs_rms.var, new_stats.obs_rms.var)
assert old_stats.obs_rms.count == new_stats.obs_rms.count
training = json.loads((output / "training.json").read_text())
assert training["resumeSource"] == "runtime"
proof = {"nonce": ${JSON.stringify(researcher.tag)}, "runId": os.environ["PAI_WORKFLOW_ID"],
         "sourceAttempt": 1, "targetAttempt": 2, "initialTimesteps": 128, "finalTimesteps": 192,
         "optimizerUpdatesBefore": before._n_updates, "optimizerUpdatesAfter": after._n_updates,
         "optimizerRestored": True, "normalizationRestored": True,
         "publicationId": receipt["publicationId"], "manifestHash": receipt["manifestHash"]}
(output / "proof").mkdir()
(output / "proof/recovery.json").write_text(json.dumps(proof, sort_keys=True) + "\\n")
`;
  const workflow: CPUWorkflow = {
    name, task: 'train', dataset,
    yaml: YAML.stringify({ workflow: {
      name, resources: { cpu: { cpu: 1, memory: '2Gi', gpu: 0 } },
      timeout: { queue_timeout: '8m', start_timeout: '8m', exec_timeout: '5m' },
      tasks: [{
        name: 'train', resource: 'cpu', image, command: ['python', '-c'], args: [script],
        retry: { max_retries: 1, backoff_seconds: 1 }, exitActions: { COMPLETE: 0, RESCHEDULE: 75 },
        checkpoint: [{ path: '{{output}}', url: 'auto', frequency: '30s',
          regex: '^(final|checkpoints/step-[0-9]+)/(model\\.zip|vecnormalize\\.pkl|manifest\\.json)$' }],
        outputs: [{ dataset: { name: dataset, path: '{{output}}/proof' } }],
      }],
    } }, { lineWidth: 0 }),
  };
  const run = await researcher.submit(workflow);
  const detail = await researcher.completed(run.id);
  const task = detail.tasks.find(value => value.name === 'train')!;
  expect(task.attempts).toBe(2);
  expect(task.runtimeFailure ?? false).toBe(false);
  const published = task.publishedVersions?.find(value => value.dataset === dataset);
  requireCondition(published, 'Recovered attempt did not publish its proof artifact');
  const version = await researcher.readyVersion(dataset, published.version);
  const proof = JSON.parse((await researcher.versionFile(version, 'recovery.json')).toString('utf8'));
  expect(proof).toMatchObject({
    nonce: researcher.tag, runId: run.id, sourceAttempt: 1, targetAttempt: 2,
    initialTimesteps: 128, finalTimesteps: 192, optimizerRestored: true, normalizationRestored: true,
  });
  expect(proof.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(proof.publicationId).toMatch(/^[a-f0-9]{64}$/);
  expect(proof.optimizerUpdatesAfter).toBeGreaterThan(proof.optimizerUpdatesBefore);
  await info.attach('checkpoint-recovery-proof', { contentType: 'application/json', body: Buffer.from(JSON.stringify(proof, null, 2)) });
});
