import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { test, expect, budgets, requireCondition } from './researcher-helpers/fixture';
import type { Run, Task } from './researcher-helpers/contracts';

// Second-release opt-in, in addition to the existing researcher fixture's gate.
// Collection/typechecking never authenticates, submits work, or reads password values.
// Parent only: DASHBOARD_DISTRIBUTED_LIVE=1 DASHBOARD_RESEARCHER_LIVE=1
//   npx --no-install playwright test e2e/distributed.spec.ts --workers=1 --retries=0
// This test intentionally fails on a missing recipe/image/runtime/API once enabled.
test.skip(process.env.DASHBOARD_DISTRIBUTED_LIVE !== '1', 'Enable only after the parent deploys the distributed CPU recipe.');
test.use({ ignoreHTTPSErrors: false, screenshot: 'off', trace: 'off', video: 'off' });
test.describe.configure({ retries: 0 });
test.setTimeout(30 * 60_000);

interface CatalogRecipe { id: string; yaml: string; templateVersion: number; contentHash: string }
interface BackendJob {
  name: string; namespace: string; workflowId?: string; task?: string; completions: number;
  nodeSelector?: Record<string, string>; pods: Array<{ name: string; node?: string; phase?: string }>;
}
interface DistributedTask extends Task { replicas: number; workloadKind: string; jobName: string; attemptEpoch: string }
interface Proof {
  schemaVersion: number; recipe: string; runId: string; taskName: string; attempt: number; epoch: string;
  rank: number; replicaIndex: number; worldSize: number; backend: string; device: string;
  podHostname: string; observedRanks: number[]; localContribution: number; allReduceSum: number;
  steps: number; seed: number; learningRate: number; initialLoss: number; finalLoss: number;
  firstAveragedGradient: number; finalWeight: number; gatheredWeights: number[];
  modelSha256: string; weightsSha256: string;
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('two CPU nodes run real Torch/Gloo collectives and publish matching trained weights in READY artifacts', async ({ researcher }, info) => {
  const checkTopology = process.env.DASHBOARD_DISTRIBUTED_TOPOLOGY === '1';
  const recipe = await researcher.api<CatalogRecipe>('GET', '/api/templates/torch-gloo-2rank');
  requireCondition(recipe.id === 'torch-gloo-2rank' && Number.isSafeInteger(recipe.templateVersion) && recipe.templateVersion > 0 && /^[a-f0-9]{64}$/.test(recipe.contentHash),
    'A deployed, immutable distributed recipe revision is required; no local/custom fallback is permitted');
  const document = YAML.parse(recipe.yaml);
  const groups = document.workflow?.groups;
  requireCondition(Array.isArray(groups) && groups.length === 1 && groups[0].tasks?.length === 1, 'The deployed recipe must contain one coordinated training group');
  const training = groups[0].tasks[0];
  requireCondition(training.name === 'train' && training.parallelism === 2 && training.lead === true && groups[0].barrier === true && groups[0].ignoreNonleadStatus === false,
    'Both indexed training replicas must participate in the real runtime barrier');
  const resource = document.workflow.resources?.[training.resource];
  requireCondition(resource?.cpu === 8 && resource.platform === 'ml.c5.4xlarge' && resource.gpu === 0 && !resource.efa,
    'This probe requires exactly 8 CPU cores per rank on the existing CPU profile');
  const image = document['default-values']?.image;
  requireCondition(typeof image === 'string' && image.length > 0 && !image.startsWith('required://'), 'MUJOCO_IMAGE_URI must already resolve to the existing Torch-capable image');
  requireCondition(training.environment?.MASTER_ADDR === '{{host:train:0}}', 'Rank-zero address must use deterministic same-group DNS');

  const name = `e2e-gloo-${researcher.tag}`;
  document.workflow.name = name;
  document.workflow.labels = { ...document.workflow.labels, 'e2e-suite': 'distributed-cpu', 'e2e-run': researcher.tag };
  document['default-values'].steps = '8';
  document['default-values'].observe_seconds = '15'; // Bounded backend placement observation, after real training.
  if (checkTopology) resource.topology = [{ key: 'zone', group: 'training-zone', requirementType: 'required' }];
  const record: { id?: string; name: string; task: string; idempotencyKey: string; status?: string } = { name, task: 'train', idempotencyKey: `distributed-${name}` };
  researcher.runs.push(record); // Keep creation intent for the fixture's owned-resource cleanup.
  const run = await researcher.api<Run>('POST', '/api/workflows', { yaml: YAML.stringify(document, { lineWidth: 0 }), templateId: recipe.id, templateVersion: recipe.templateVersion, acknowledgePreflight: true },
    [202], budgets.api, { 'idempotency-key': record.idempotencyKey });
  requireCondition(typeof run.id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(run.id) && run.name === name && run.projectId === researcher.project.id && run.ownerSubject === researcher.principal.subject,
    'Submission must belong to this exact test identity/project/name');
  record.id = run.id; record.status = run.status;
  const dataset = `torch-gloo-${run.id}`;
  researcher.datasets.push({ name: dataset });

  // Capture actual Kubernetes spec.nodeName values while Pods still exist. Pod hostnames alone
  // are not node-placement evidence, and a terminal run is not an acceptable substitute.
  const placement = await researcher.poll('two distinct backend CPU nodeNames', budgets.running, async remaining => {
    const detail = await researcher.detail(run.id, remaining);
    requireCondition(!['FAILED', 'CANCELLED'].includes(detail.workflow.status), 'Distributed run failed before placement proof');
    const jobs = await researcher.api<BackendJob[]>('GET', `/api/k8s/jobs?ns=${encodeURIComponent(researcher.project.namespace)}`, undefined, [200], remaining);
    const matching = jobs.filter(job => job.workflowId === run.id && job.task === 'train' && job.namespace === researcher.project.namespace);
    return { detail, jobs: matching, pods: matching.flatMap(job => job.pods) };
  }, observation => {
    const nodes = new Set(observation.pods.flatMap(pod => pod.node ? [pod.node] : []));
    return observation.jobs.length === 1 && observation.jobs[0].completions === 2 && observation.pods.length === 2 && nodes.size === 2;
  }, observation => `${observation.detail.workflow.status}; ${observation.pods.length} Pods; ${new Set(observation.pods.map(pod => pod.node).filter(Boolean)).size} backend nodes`);
  expect(placement.jobs[0].nodeSelector?.['node.kubernetes.io/instance-type']).toBe('ml.c5.4xlarge');
  expect(new Set(placement.pods.map(pod => pod.node)).size).toBe(2);
  let topologyEvidence: { key: string; domain: string; nodes: Array<{ name: string; domain: string }> } | undefined;
  if (checkTopology) {
    const kubeconfig = process.env.DASHBOARD_TOPOLOGY_KUBECONFIG;
    requireCondition(kubeconfig, 'Live topology proof requires the parent-selected read-only kubeconfig');
    const names = [...new Set(placement.pods.map(pod => pod.node!))];
    const { stdout } = await promisify(execFile)('kubectl', ['--kubeconfig', kubeconfig, 'get', 'nodes', ...names, '-o', 'json'], { maxBuffer: 2 * 1024 ** 2 });
    const nodes = (JSON.parse(stdout) as { items: Array<{ metadata: { name: string; labels: Record<string, string> } }> }).items;
    const selector = placement.jobs[0].nodeSelector ?? {};
    const key = ['topology.k8s.aws/zone-id', 'topology.kubernetes.io/zone'].find(label => selector[label]);
    requireCondition(key && nodes.length === 2, 'The native topology plan must expose its required physical zone selector');
    const domain = selector[key];
    for (const node of nodes) expect(node.metadata.labels[key], `Actual Node ${node.metadata.name} zone label`).toBe(domain);
    topologyEvidence = { key, domain, nodes: nodes.map(node => ({ name: node.metadata.name, domain: node.metadata.labels[key] })) };
  }

  const detail = await researcher.completed(run.id);
  expect(detail.tasks).toHaveLength(1);
  const task = detail.tasks[0] as DistributedTask;
  expect(task).toMatchObject({ name: 'train', replicas: 2, workloadKind: 'JobSet', phase: 'SUCCEEDED', exitCode: 0 });
  expect(task.runtimeFailure ?? false).toBe(false);
  const publication = task.publishedVersions?.find(item => item.dataset === dataset);
  requireCondition(publication, 'The completed group did not publish its run-scoped output');
  const version = await researcher.readyVersion(dataset, publication.version);
  expect(version.producedBy).toEqual({ workflowId: run.id, task: 'train' });
  const receipt = Object.values(task.artifactReceipts ?? {}).find(item => item.manifestHash === version.manifestHash);
  requireCondition(receipt && receipt.uri === version.uri && receipt.manifestUri === version.manifestUri, 'READY output must match the task finalization receipt');
  expect(version.objectCount).toBe(6); // proof.json, weights.json, model.pt for each rank.

  const proofs: Proof[] = [];
  const observedNodes: string[] = [];
  for (const rank of [0, 1]) {
    const proof = JSON.parse((await researcher.versionFile(version, `rank-${rank}/proof.json`)).toString('utf8')) as Proof;
    const weightsBytes = await researcher.versionFile(version, `rank-${rank}/weights.json`);
    const modelBytes = await researcher.versionFile(version, `rank-${rank}/model.pt`);
    expect(proof).toMatchObject({ schemaVersion: 1, recipe: 'torch-gloo-2rank', runId: run.id, taskName: 'train', attempt: task.attempts,
      epoch: task.attemptEpoch, rank, replicaIndex: rank, worldSize: 2, backend: 'gloo', device: 'cpu', observedRanks: [0, 1],
      localContribution: rank + 1, allReduceSum: 3, steps: 8, learningRate: 0.1, firstAveragedGradient: -10, initialLoss: 10 });
    expect(proof.finalWeight).toBeCloseTo(1.9921875, 10);
    expect(proof.finalLoss).toBeCloseTo(10 / 65536, 10);
    expect(proof.gatheredWeights).toHaveLength(2);
    proof.gatheredWeights.forEach(weight => expect(weight).toBeCloseTo(proof.finalWeight, 12));
    expect(proof.modelSha256).toBe(sha256(modelBytes));
    expect(proof.weightsSha256).toBe(sha256(weightsBytes));
    requireCondition(modelBytes.length > 256 && modelBytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'Missing actual Torch checkpoint archive');
    const weights = JSON.parse(weightsBytes.toString('utf8'));
    expect(weights).toMatchObject({ architecture: 'Linear(1,1,bias=False)', dtype: 'float64', device: 'cpu' });
    expect(weights.state_dict.weight).toHaveLength(1);
    expect(weights.state_dict.weight[0]).toHaveLength(1);
    expect(weights.state_dict.weight[0][0]).toBeCloseTo(proof.finalWeight, 12);
    const pod = placement.pods.find(item => item.name === proof.podHostname || item.name.startsWith(proof.podHostname + '-'));
    requireCondition(pod?.node, 'Rank proof hostname does not match a backend Pod with a real nodeName');
    observedNodes.push(pod.node); proofs.push(proof);
  }
  expect(new Set(observedNodes).size).toBe(2);
  expect(proofs[0].finalWeight).toBe(proofs[1].finalWeight);
  expect(proofs[0].weightsSha256).toBe(proofs[1].weightsSha256);
  await info.attach('distributed-cpu-proof', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    runId: run.id, templateVersion: recipe.templateVersion, sourceContentHash: recipe.contentHash,
    dataset, version: version.version, manifestHash: version.manifestHash,
    backendPods: placement.pods.map(pod => ({ pod: pod.name, nodeName: pod.node })),
    topology: topologyEvidence,
    ranks: proofs.map(proof => ({ rank: proof.rank, allReduceSum: proof.allReduceSum, firstAveragedGradient: proof.firstAveragedGradient,
      finalWeight: proof.finalWeight, finalLoss: proof.finalLoss, modelSha256: proof.modelSha256 })),
  }, null, 2)) });
});
