import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Job, Pod } from '../k8s/resources';
import { managedLabels } from '../k8s/resources';
import type { Workflow, Task } from '../store/types';

export const INVENTORY_LIMIT = 4 * 1024 * 1024;
export const INVENTORY_FILES = 10_000;
export interface InventoryFile { path: string; bytes: number; sha256: string }
export interface ArtifactInventory {
  schemaVersion: 1; identity: string; kind: 'directory' | 'file';
  files: InventoryFile[]; hash: string;
}
export interface InventoryScope {
  workflow: Workflow; task: Task; sourcePath: string; publicationId: string; attempt: number;
}
export const inventoryIdentity = (input: InventoryScope) => `workflow:${input.publicationId}:${input.attempt}`;
export const inventoryName = (input: InventoryScope) =>
  `pai-inventory-${createHash('sha256').update(inventoryIdentity(input)).digest('hex').slice(0, 40)}`;
export const inventoryFence = (workflowId: string, task: string, attempt: number) =>
  ({ pk: `WF#${workflowId}`, sk: `ARTIFACT_FENCE#${task}#${attempt}` });
export const inventoryRecord = (input: InventoryScope) =>
  ({ pk: `WF#${input.workflow.id}`, sk: `ARTIFACT#${input.task.name}#${input.attempt}#${inventoryName(input)}` });

export function safeArtifactPath(path: string) {
  if (!path || path.length > 2048 || path.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe artifact path');
  return path;
}

export function validateInventoryScope(input: InventoryScope) {
  const { workflow, task, sourcePath, attempt } = input;
  if (!workflow.projectId || !workflow.spec.workflow.queue || !Number.isSafeInteger(attempt) || attempt < 1 ||
      !workflow.namespace.startsWith('hyperpod-ns-') ||
      task.workflowId !== workflow.id || task.attempts !== attempt) throw new Error('Inventory requires a project, queue and current attempt');
  for (const value of [workflow.id, workflow.projectId, task.name, workflow.namespace]) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new Error('Invalid inventory identity');
  }
  const root = `/fsx/checkpoints/projects/${workflow.projectId}/runs/${workflow.id}/attempts/${attempt}/${task.name}`;
  if (task.outputPath !== root || posix.normalize(sourcePath) !== sourcePath ||
      (sourcePath !== root && !sourcePath.startsWith(root + '/'))) throw new Error('Inventory source must be inside the exact task attempt output');
  safeArtifactPath(sourcePath.slice('/fsx/'.length));
}

// Kubelet resolves subPath symlinks before mounting. Check the original path
// from the project root (created/protected by trusted storage preparation), then
// bind the narrow reader to exactly that verified inode. This init never lists
// siblings, hashes project files, or writes FSx; its only write is a private
// emptyDir receipt consumed read-only by the main collector.
export const VERIFY_SOURCE_PYTHON = String.raw`
import json, os, stat, sys
anchor, relative, identity, receipt = sys.argv[1:]
parts = relative.split("/")
if any(not p or p in (".", "..") for p in parts):
    raise ValueError("unsafe source path")
fd = os.open(anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    for index, part in enumerate(parts):
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if index < len(parts) - 1:
            flags |= os.O_DIRECTORY
        child = os.open(part, flags, dir_fd=fd)
        os.close(fd)
        fd = child
    source = os.fstat(fd)
    if not stat.S_ISDIR(source.st_mode) and not stat.S_ISREG(source.st_mode):
        raise ValueError("source must be a regular file or directory")
    with open(receipt, "x") as output:
        json.dump({"identity": identity, "device": source.st_dev, "inode": source.st_ino,
                   "kind": stat.S_IFMT(source.st_mode)}, output)
finally:
    os.close(fd)
`;

// Python stdlib only, passed in a trusted Job command (never supplied by YAML).
// dir_fd + O_NOFOLLOW prevent symlink traversal and open/stat substitution;
// O_NONBLOCK prevents a racing FIFO from hanging an open. File/directory change
// detection rejects writes during enumeration. No stdout until all files hash.
export const INVENTORY_PYTHON = String.raw`
import hashlib, json, os, stat, sys
LIMIT, MAX_FILES = 4194304, 10000
root, identity, basename = sys.argv[1:4]
lines, total, total_bytes = [], 0, 0
digest = hashlib.sha256()
def stable(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
def emit_file(fd, path):
    global total, total_bytes
    if not path or len(path) > 2048 or any(ord(c) < 32 or ord(c) == 127 for c in path) or "\\" in path:
        raise ValueError("unsafe filename")
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode):
        raise ValueError("only regular files may be published")
    h, size = hashlib.sha256(), 0
    while True:
        block = os.read(fd, 1024 * 1024)
        if not block:
            break
        h.update(block)
        size += len(block)
    if stable(before) != stable(os.fstat(fd)) or size != before.st_size:
        raise ValueError("file changed while hashing")
    line = json.dumps({"path": path, "bytes": size, "sha256": h.hexdigest()}, ensure_ascii=True, separators=(",", ":")) + "\n"
    total += len(line.encode())
    total_bytes += size
    if len(lines) >= MAX_FILES or total > LIMIT - 8192 or total_bytes > 9007199254740991:
        raise ValueError("inventory exceeds bounded limit")
    lines.append(line)
    digest.update(line.encode())
def walk(fd, prefix, depth=0):
    if depth > 64:
        raise ValueError("directory nesting exceeds limit")
    before = os.fstat(fd)
    names = sorted(os.listdir(fd))
    for name in names:
        previous = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISREG(previous.st_mode) and not stat.S_ISDIR(previous.st_mode):
            raise ValueError("symlinks and special files are forbidden")
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if stat.S_ISDIR(previous.st_mode):
            flags |= os.O_DIRECTORY
        child = os.open(name, flags, dir_fd=fd)
        try:
            if stable(previous) != stable(os.fstat(child)):
                raise ValueError("entry changed while opening")
            path = prefix + name
            if stat.S_ISDIR(previous.st_mode):
                walk(child, path + "/", depth + 1)
            else:
                emit_file(child, path)
        finally:
            os.close(child)
    if stable(before) != stable(os.fstat(fd)) or names != sorted(os.listdir(fd)):
        raise ValueError("directory changed while enumerating")
fd = os.open(root, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
try:
    if len(sys.argv) > 4:
        with open(sys.argv[4]) as receipt:
            verified = json.load(receipt)
        mounted = os.fstat(fd)
        if verified != {"identity": identity, "device": mounted.st_dev, "inode": mounted.st_ino,
                        "kind": stat.S_IFMT(mounted.st_mode)}:
            raise ValueError("mounted source differs from verified no-symlink path")
    kind = "directory" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file"
    if kind == "directory":
        walk(fd, "")
    else:
        emit_file(fd, basename)
finally:
    os.close(fd)
if not lines:
    raise ValueError("output contains no regular files")
header = json.dumps({"schemaVersion": 1, "identity": identity, "kind": kind}, separators=(",", ":")) + "\n"
footer = json.dumps({"complete": True, "files": len(lines), "bytes": total_bytes, "sha256": digest.hexdigest()}, separators=(",", ":")) + "\n"
payload = header + "".join(lines) + footer
if len(payload.encode()) > LIMIT:
    raise ValueError("inventory log exceeds limit")
sys.stdout.write(payload)
`;

export function parseInventory(text: string, identity: string): ArtifactInventory {
  if (Buffer.byteLength(text) > INVENTORY_LIMIT || !text.endsWith('\n')) throw new Error('Incomplete or oversized inventory log');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 3 || lines.length > INVENTORY_FILES + 2) throw new Error('Invalid inventory record count');
  const header = JSON.parse(lines[0]);
  const footer = JSON.parse(lines.at(-1)!);
  if (header.schemaVersion !== 1 || header.identity !== identity || !['directory', 'file'].includes(header.kind)) throw new Error('Inventory identity mismatch');
  const hash = createHash('sha256').update(lines.slice(1, -1).join('\n') + '\n').digest('hex');
  const files: InventoryFile[] = lines.slice(1, -1).map(line => {
    const file = JSON.parse(line);
    if (typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid inventory file');
    safeArtifactPath(file.path);
    if (file.path === 'manifest.json' || file.path === '.pai' || file.path.startsWith('.pai/')) {
      throw new Error('Output path conflicts with publication metadata; publish its parent directory');
    }
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (new Set(files.map(file => file.path)).size !== files.length || header.kind === 'file' && files.length !== 1 ||
      !Number.isSafeInteger(bytes) || footer.complete !== true || footer.files !== files.length ||
      footer.bytes !== bytes || footer.sha256 !== hash) throw new Error('Incomplete or corrupted inventory');
  return { schemaVersion: 1, identity, kind: header.kind, files, hash };
}

export function inventoryLabels(input: InventoryScope) {
  return managedLabels({
    'pai.aws/component': 'artifact-inventory', 'pai.aws/project': input.workflow.projectId!,
    'pai.aws/workflow-id': input.workflow.id, 'pai.aws/task': input.task.name,
    'pai.aws/attempt': String(input.attempt), 'pai.aws/publication': inventoryName(input),
    ...(input.task.attemptEpoch ? { 'pai.aws/epoch': input.task.attemptEpoch } : {}),
  });
}

export function inventoryJob(input: InventoryScope, image: string) {
  validateInventoryScope(input);
  if (!image || image.startsWith('required://') || /[\s{}]/.test(image)) throw new Error('MUJOCO_IMAGE_URI must contain the trusted inventory Python image');
  const labels = { ...inventoryLabels(input), 'kueue.x-k8s.io/queue-name': input.workflow.spec.workflow.queue! };
  const projectRoot = `/fsx/checkpoints/projects/${input.workflow.projectId}`;
  const securityContext = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
  const resources = { requests: { cpu: '1', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } };
  return {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name: inventoryName(input), namespace: input.workflow.namespace, labels },
    spec: {
      suspend: true, completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 900,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never', automountServiceAccountToken: false, serviceAccountName: 'pai-workload',
          enableServiceLinks: false, terminationGracePeriodSeconds: 5,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          nodeSelector: { 'sagemaker.amazonaws.com/node-health-status': 'Schedulable', 'kubernetes.io/arch': 'amd64',
            'node.kubernetes.io/instance-type': process.env.ARTIFACT_INVENTORY_CPU_PLATFORM ?? 'ml.c5.4xlarge' },
          initContainers: [{
            name: 'verify-source', image, command: ['python', '-I', '-B', '-c', VERIFY_SOURCE_PYTHON],
            args: ['/project', input.sourcePath.slice(projectRoot.length + 1), inventoryIdentity(input), '/verification/source.json'],
            securityContext, resources,
            volumeMounts: [
              { name: 'output', mountPath: '/project', subPath: projectRoot.slice('/fsx/'.length), readOnly: true },
              { name: 'verification', mountPath: '/verification', readOnly: false },
            ],
          }],
          containers: [{
            name: 'inventory', image, imagePullPolicy: 'IfNotPresent',
            command: ['python', '-I', '-B', '-c', INVENTORY_PYTHON],
            args: ['/input', inventoryIdentity(input), posix.basename(input.sourcePath), '/verification/source.json'],
            securityContext, resources,
            volumeMounts: [
              { name: 'output', mountPath: '/input', subPath: input.sourcePath.slice('/fsx/'.length), readOnly: true },
              { name: 'verification', mountPath: '/verification', readOnly: true },
            ],
          }],
          volumes: [
            { name: 'output', persistentVolumeClaim: { claimName: 'fsx-pvc', readOnly: true } },
            { name: 'verification', emptyDir: { sizeLimit: '1Mi' } },
          ],
        },
      },
    },
  };
}

export function assertInventoryJob(job: Job, input: InventoryScope, image: string) {
  const expected = inventoryJob(input, image);
  if (!job.metadata.uid || job.metadata.name !== expected.metadata.name ||
      Object.entries(inventoryLabels(input)).some(([key, value]) => job.metadata.labels?.[key] !== value)) throw new Error('Collector ownership mismatch');
  const actual = job.spec.template.spec as unknown as Record<string, unknown>;
  // Admission may add defaults/node scheduling fields. Require all trusted
  // security, command, mounts and environment fields; reject injected containers.
  const pod = expected.spec.template.spec;
  function normalizedMounts(value: unknown) {
    if (!Array.isArray(value)) return value;
    // Kubernetes omits the false-valued readOnly field in API responses.
    // Normalize only this documented default; a missing true on either FSx
    // mount or the reader's receipt mount must still fail the comparison.
    return value.map(mount => ({ ...mount, readOnly: mount.readOnly ?? false }));
  }
  function checkContainer(value: Record<string, unknown>, template: Record<string, unknown>) {
    if (!value || ['name', 'image', 'command', 'args'].some(key => !isDeepStrictEqual(value[key], template[key])) ||
        !isDeepStrictEqual(normalizedMounts(value.volumeMounts), normalizedMounts(template.volumeMounts))) {
      throw new Error('Collector trusted command/mount mismatch');
    }
    const security = value.securityContext as Record<string, unknown>;
    if (!security || Object.entries(template.securityContext as Record<string, unknown>).some(([key, expected]) =>
      !isDeepStrictEqual(security[key], expected)) || security.privileged === true ||
      security.runAsUser !== undefined && security.runAsUser !== 1000 || security.runAsNonRoot === false ||
      (value.env as unknown[] | undefined)?.length || (value.envFrom as unknown[] | undefined)?.length) throw new Error('Collector security mismatch');
  }
  const containers = actual.containers as Record<string, unknown>[];
  const init = actual.initContainers as Record<string, unknown>[];
  if (containers?.length !== 1 || init?.length !== 1 || actual.automountServiceAccountToken !== false ||
      actual.serviceAccountName !== 'pai-workload') throw new Error('Collector trusted container isolation mismatch');
  checkContainer(containers[0], pod.containers[0]);
  checkContainer(init[0], pod.initContainers[0]);
  if (!isDeepStrictEqual(actual.volumes, pod.volumes) || actual.hostNetwork || actual.hostPID || actual.hostIPC) throw new Error('Collector volume/host isolation mismatch');
  const security = actual.securityContext as Record<string, unknown>;
  if (security?.runAsUser !== 1000 || security.runAsNonRoot !== true ||
      security.runAsGroup !== 1000 || (security.seccompProfile as { type?: string })?.type !== 'RuntimeDefault') throw new Error('Collector security mismatch');
}

export function successfulInventoryPod(pods: Pod[], job: Job): Pod {
  const successful = pods.filter(pod => {
    const owners = (pod.metadata as Pod['metadata'] & { ownerReferences?: { uid: string; controller?: boolean }[] }).ownerReferences;
    const container = pod.status?.containerStatuses?.find(item => item.name === 'inventory');
    const verification = pod.status?.initContainerStatuses?.find(item => item.name === 'verify-source');
    return owners?.some(owner => owner.uid === job.metadata.uid && owner.controller === true) &&
      pod.status?.phase === 'Succeeded' && container?.state?.terminated?.exitCode === 0 &&
      verification?.state?.terminated?.exitCode === 0;
  });
  if (successful.length !== 1) throw new Error('Collector needs exactly one owned successful Pod');
  return successful[0];
}
