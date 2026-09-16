import YAML from 'yaml';
import type { Recipe } from './contracts';

export interface CPUWorkflow {
  name: string;
  task: string;
  yaml: string;
  dataset?: string;
}

/** The custom recipe runs Python stdlib; no MuJoCo, NumPy, GPU or credentials. */
function build(recipe: Recipe, input: {
  name: string; task: string; script: string; dataset?: string;
  source?: { name: string; version: number }; completeCode?: number; long?: boolean;
}): CPUWorkflow {
  const original = YAML.parse(recipe.yaml) as { workflow?: { tasks?: unknown[] } };
  if (recipe.id !== 'custom' || !original.workflow?.tasks?.length) {
    throw new Error('The deployed custom recipe is missing or malformed');
  }
  const image = process.env.DASHBOARD_E2E_CPU_IMAGE ?? 'public.ecr.aws/docker/library/python:3.12-slim';
  if (!image || image.startsWith('required://') || /\s/.test(image)) {
    throw new Error('DASHBOARD_E2E_CPU_IMAGE must be a usable Python image reference');
  }
  const platform = process.env.DASHBOARD_E2E_CPU_PLATFORM;
  return {
    name: input.name,
    task: input.task,
    dataset: input.dataset,
    yaml: YAML.stringify({
      workflow: {
        name: input.name,
        description: 'Owned, bounded researcher integration test; real Python filesystem data.',
        mlflow: false,
        timeout: { queue_timeout: '8m', start_timeout: '5m', exec_timeout: input.long ? '20m' : '2m' },
        resources: { cpu: { cpu: 1, memory: '1Gi', gpu: 0, ...(platform ? { platform } : {}) } },
        labels: { 'e2e-suite': 'researcher', 'e2e-run': input.name },
        tasks: [{
          name: input.task, resource: 'cpu', image, command: ['python', '-c'], args: [input.script],
          retry: { max_retries: 0 },
          exitActions: { COMPLETE: input.completeCode ?? 0 },
          inputs: input.source ? [{ dataset: input.source }] : [],
          outputs: input.dataset ? [{ dataset: { name: input.dataset, path: '{{output}}/artifact' } }] : [],
        }],
      },
    }, { lineWidth: 0 }),
  };
}

export function producerWorkflow(recipe: Recipe, tag: string): CPUWorkflow {
  return build(recipe, {
    name: `e2e-produce-${tag}`, task: 'produce', dataset: `e2e-artifact-${tag}`, completeCode: 7,
    script: `
import json, os, pathlib, sys
root = pathlib.Path(os.environ["PAI_OUTPUT_DIR"]) / "artifact"
root.mkdir(parents=True, exist_ok=True)
proof = {"nonce": ${JSON.stringify(tag)}, "runId": os.environ["PAI_WORKFLOW_ID"], "values": [2, 3, 5], "sum": 10}
path = root / "proof.json"
path.write_text(json.dumps(proof, sort_keys=True) + "\\n")
assert json.loads(path.read_text()) == proof
print("E2E_PRODUCED " + json.dumps(proof), flush=True)
sys.exit(7)
`,
  });
}

export function hydratedWorkflow(recipe: Recipe, tag: string, source: {
  name: string; version: number; manifestHash: string; sha256: string;
}): CPUWorkflow {
  return build(recipe, {
    name: `e2e-hydrate-${tag}`, task: 'consume', dataset: `e2e-hydrated-${tag}`,
    source: { name: source.name, version: source.version },
    script: `
import hashlib, json, os, pathlib
source = pathlib.Path("{{input:0}}")
payload = (source / "records.json").read_bytes()
digest = hashlib.sha256(payload).hexdigest()
assert digest == ${JSON.stringify(source.sha256)}, "Hydrated file bytes differ"
receipt = json.loads((source / ".pai-input-receipt.json").read_text())
assert receipt["version"] == 1
assert receipt["manifestHash"] == ${JSON.stringify(source.manifestHash)}, "Hydration receipt is not the pinned manifest"
record = json.loads(payload)
assert record["nonce"] == ${JSON.stringify(tag)}
proof = {"nonce": record["nonce"], "runId": os.environ["PAI_WORKFLOW_ID"],
         "sum": sum(record["values"]), "inputSha256": digest,
         "manifestHash": receipt["manifestHash"], "inputPath": str(source)}
output = pathlib.Path(os.environ["PAI_OUTPUT_DIR"]) / "artifact"
output.mkdir(parents=True, exist_ok=True)
(output / "proof.json").write_text(json.dumps(proof, sort_keys=True) + "\\n")
print("E2E_HYDRATED " + json.dumps(proof), flush=True)
`,
  });
}

export function sessionWorkflow(recipe: Recipe, tag: string): CPUWorkflow {
  return build(recipe, {
    name: `e2e-session-${tag}`, task: 'hold', long: true,
    script: `
import json, os, pathlib, time
output = pathlib.Path(os.environ["PAI_OUTPUT_DIR"])
output.mkdir(parents=True, exist_ok=True)
(output / "session-marker.json").write_text(json.dumps({"nonce": ${JSON.stringify(tag)}, "runId": os.environ["PAI_WORKFLOW_ID"]}))
print("E2E_SESSION_READY", flush=True)
deadline = time.monotonic() + 20 * 60
while time.monotonic() < deadline:
    time.sleep(1)
raise SystemExit("E2E session lifetime elapsed without cleanup")
`,
  });
}
