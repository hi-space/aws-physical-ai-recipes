import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INVENTORY_PYTHON, VERIFY_SOURCE_PYTHON, assertInventoryJob, inventoryIdentity, inventoryJob, inventoryName, parseInventory,
  validateInventoryScope, type InventoryScope,
} from './artifact-inventory';
import { workflowSchema } from '../workflow/schema';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pai-inventory-')); dirs.push(dir);
  return dir;
}
export function scope(): InventoryScope {
  const path = '/fsx/checkpoints/projects/p/runs/run/attempts/1/train';
  return {
    publicationId: 'run:train:output0', attempt: 1, sourcePath: path,
    workflow: {
      id: 'run', name: 'run', namespace: 'hyperpod-ns-p', projectId: 'p', owner: 'alice', status: 'FINALIZING',
      spec: workflowSchema.parse({ workflow: { name: 'run', queue: 'project-queue', resources: { cpu: { cpu: 1 } },
        tasks: [{ name: 'train', resource: 'cpu', image: 'application', command: ['true'] }] } }),
      specYaml: '', vars: {}, createdAt: '', updatedAt: '', taskCount: 1, succeededCount: 0, failedCount: 0,
    },
    task: { workflowId: 'run', name: 'train', phase: 'FINALIZING', attempts: 1, replicas: 1, outputPath: path, attemptEpoch: 'epoch', updatedAt: '' },
  };
}
const execute = (path: string, identity = 'publication') =>
  execFileSync('python3', ['-I', '-B', '-c', INVENTORY_PYTHON, path, identity, 'selected.bin'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('trusted filesystem inventory', () => {
  it('hashes actual nested bytes including empty files and validates its completion envelope', () => {
    const root = fixture();
    mkdirSync(join(root, 'final'));
    writeFileSync(join(root, 'final', 'model.zip'), Buffer.from([0, 255, 1, 17]));
    writeFileSync(join(root, 'empty'), '');
    const inventory = parseInventory(execute(root), 'publication');
    expect(inventory.kind).toBe('directory');
    expect(inventory.files).toEqual([
      { path: 'empty', bytes: 0, sha256: createHash('sha256').update('').digest('hex') },
      { path: 'final/model.zip', bytes: 4, sha256: createHash('sha256').update(Buffer.from([0, 255, 1, 17])).digest('hex') },
    ]);
  });
  it('inventories a single declared file without broadening to siblings', () => {
    const root = fixture(); writeFileSync(join(root, 'chosen'), 'chosen'); writeFileSync(join(root, 'other'), 'private');
    const inventory = parseInventory(execute(join(root, 'chosen')), 'publication');
    expect(inventory.kind).toBe('file');
    expect(inventory.files.map(file => file.path)).toEqual(['selected.bin']);
  });
  it.each(['file', 'directory', 'root'])('rejects a %s symlink with no completed inventory', type => {
    const root = fixture(); const outside = fixture();
    writeFileSync(join(outside, 'secret'), 'must never be followed');
    symlinkSync(type === 'file' ? join(outside, 'secret') : outside, join(root, 'link'));
    const result = spawnSync('python3', ['-I', '-B', '-c', INVENTORY_PYTHON,
      type === 'root' ? join(root, 'link') : root, 'publication', 'selected.bin'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
  });
  it('rejects FIFOs without blocking', () => {
    const root = fixture(); execFileSync('mkfifo', [join(root, 'pipe')]);
    const result = spawnSync('python3', ['-I', '-B', '-c', INVENTORY_PYTHON, root, 'publication', 'x'], { timeout: 2000, encoding: 'utf8' });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
  });
  it('rejects truncation, wrong identity, digest tampering and reserved manifest collisions', () => {
    const root = fixture(); writeFileSync(join(root, 'model.zip'), 'abc');
    const text = execute(root);
    expect(() => parseInventory(text.slice(0, -2), 'publication')).toThrow(/Incomplete/);
    expect(() => parseInventory(text, 'other')).toThrow(/identity/);
    expect(() => parseInventory(text.replace('"bytes":3', '"bytes":4'), 'publication')).toThrow(/corrupted/);
    writeFileSync(join(root, 'manifest.json'), '{}');
    expect(() => parseInventory(execute(root), 'publication')).toThrow(/conflicts/);
  });
  it('rejects empty outputs and filenames unsafe for archive paths', () => {
    const root = fixture();
    expect(() => execute(root)).toThrow();
    writeFileSync(join(root, 'unsafe\nname'), 'x');
    expect(() => execute(root)).toThrow();
  });
  it('detects a same-size file rewrite during hashing and emits no inventory', () => {
    const root = fixture(); writeFileSync(join(root, 'checkpoint'), 'original');
    const rewriteDuringRead = `
import os, sys
original_read = os.read
changed = False
def read_then_change(fd, size):
    global changed
    block = original_read(fd, size)
    if block and not changed:
        changed = True
        with open(os.path.join(sys.argv[1], "checkpoint"), "wb") as output:
            output.write(b"modified")
    return block
os.read = read_then_change
`;
    const result = spawnSync('python3', ['-I', '-B', '-c', rewriteDuringRead + INVENTORY_PYTHON, root, 'publication', 'x'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('file changed while hashing');
    expect(result.stdout).toBe('');
  });
  it('tolerates ctime-only changes during hashing (FSx export/HSM state flips) while keeping the bytes', () => {
    const root = fixture(); writeFileSync(join(root, 'checkpoint'), 'original');
    const chmodDuringRead = `
import os, sys
original_read = os.read
changed = False
def read_then_chmod(fd, size):
    global changed
    block = original_read(fd, size)
    if block and not changed:
        changed = True
        os.chmod(os.path.join(sys.argv[1], "checkpoint"), 0o640)
        os.chmod(os.path.join(sys.argv[1], "checkpoint"), 0o644)
    return block
os.read = read_then_chmod
`;
    const result = spawnSync('python3', ['-I', '-B', '-c', chmodDuringRead + INVENTORY_PYTHON, root, 'publication', 'x'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"path":"checkpoint"');
  });
  it('verifies source ancestors before a narrow bind mount can hide their symlinks', () => {
    const project = fixture(), outside = fixture(), receipt = join(fixture(), 'receipt.json');
    writeFileSync(join(outside, 'secret'), 'private');
    symlinkSync(outside, join(project, 'alias'));
    const result = spawnSync('python3', ['-I', '-B', '-c', VERIFY_SOURCE_PYTHON,
      project, 'alias/secret', 'publication', receipt], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
  });
  it('accepts the verified source inode and rejects a substituted mount', () => {
    const project = fixture(), output = join(project, 'output'), other = fixture(), receipt = join(fixture(), 'receipt.json');
    mkdirSync(output); writeFileSync(join(output, 'model.zip'), 'real'); writeFileSync(join(other, 'model.zip'), 'other');
    execFileSync('python3', ['-I', '-B', '-c', VERIFY_SOURCE_PYTHON, project, 'output', 'publication', receipt]);
    const text = execFileSync('python3', ['-I', '-B', '-c', INVENTORY_PYTHON, output, 'publication', 'output', receipt], { encoding: 'utf8' });
    expect(parseInventory(text, 'publication').files[0].sha256).toBe(createHash('sha256').update('real').digest('hex'));
    const changed = spawnSync('python3', ['-I', '-B', '-c', INVENTORY_PYTHON, other, 'publication', 'output', receipt], { encoding: 'utf8' });
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toContain('mounted source differs');
    expect(changed.stdout).toBe('');
  });
});

describe('collector isolation', () => {
  it('accepts Kubernetes omission of readOnly:false without accepting writable FSx or receipt mounts', () => {
    const input = scope(), image = 'registry/mujoco:verified';
    const returned = JSON.parse(JSON.stringify(inventoryJob(input, image)));
    returned.metadata.uid = 'collector-uid';
    delete returned.spec.template.spec.initContainers[0].volumeMounts[1].readOnly;
    expect(() => assertInventoryJob(returned, input, image)).not.toThrow();
    for (const [kind, index] of [['initContainers', 0], ['containers', 0], ['containers', 1]] as const) {
      const unsafe = structuredClone(returned);
      delete unsafe.spec.template.spec[kind][0].volumeMounts[index].readOnly;
      expect(() => assertInventoryJob(unsafe, input, image)).toThrow(/mount mismatch/);
    }
  });
  it('mounts exactly the attempt output read-only with CPU, project queue and no credentials', () => {
    const input = scope(); const job = inventoryJob(input, 'registry/mujoco:verified');
    expect(job.metadata.name).toBe(inventoryName(input));
    expect(job.metadata.labels).toMatchObject({ 'pai.aws/project': 'p', 'kueue.x-k8s.io/queue-name': 'project-queue' });
    expect(job.spec.suspend).toBe(true);
    const pod = job.spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000 });
    expect(pod.containers[0].securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(pod.containers[0].volumeMounts).toEqual([
      { name: 'output', mountPath: '/input', subPath: input.sourcePath.slice(5), readOnly: true },
      { name: 'verification', mountPath: '/verification', readOnly: true },
    ]);
    expect(pod.initContainers[0].volumeMounts[0]).toEqual({
      name: 'output', mountPath: '/project', subPath: 'checkpoints/projects/p', readOnly: true,
    });
    expect(pod.initContainers[0].args[1]).toBe('runs/run/attempts/1/train');
    expect(pod.containers[0].args[1]).toBe(inventoryIdentity(input));
    expect(JSON.stringify(pod)).not.toContain('nvidia.com/gpu');
    expect(JSON.stringify(pod)).not.toContain('AWS_ACCESS_KEY');
  });
  it('rejects traversal, other attempts, projectless runs and an unresolved trusted image', () => {
    const input = scope();
    for (const sourcePath of [input.sourcePath + '/../other', input.sourcePath + '/./x', '/fsx/datasets/other']) {
      expect(() => validateInventoryScope({ ...input, sourcePath })).toThrow();
    }
    expect(() => validateInventoryScope({ ...input, attempt: 2 })).toThrow();
    expect(() => validateInventoryScope({ ...input, workflow: { ...input.workflow, projectId: undefined } })).toThrow();
    expect(() => inventoryJob(input, 'required://MUJOCO_IMAGE_URI')).toThrow();
  });
});
