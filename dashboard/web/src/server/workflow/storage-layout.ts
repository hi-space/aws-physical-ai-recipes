import { assertSafePath, shellQuote } from './validation';
export type SharedReadOnlyPath = 'envs' | 'workshop';
export interface VolumeMount {
  name: string;
  mountPath: string;
  subPath?: string;
  readOnly?: boolean;
}
export const workloadSecurity = {
  runAsUser: 1000,
  runAsGroup: 1000,
  runAsNonRoot: true,
  allowPrivilegeEscalation: false,
  capabilities: {
    drop: ['ALL']
  },
  seccompProfile: {
    type: 'RuntimeDefault'
  }
};
export function projectRoots(project: string): string[] {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(project)) throw new Error('invalid project identity');
  return [`/fsx/checkpoints/projects/${project}`, `/fsx/datasets/projects/${project}`];
}
export function assertProjectInput(path: string, project: string): void {
  assertSafePath(path);
  if (!projectRoots(project).some(root => path.startsWith(root + '/'))) throw new Error('input path must be a narrow path within the authorized project');
}
export function assertInputMount(path: string, source: string, project?: string): void {
  assertSafePath(path);
  if (['/opt/pai', '/pai', '/proc', '/sys', '/dev', '/etc', '/var/run/secrets'].some(root => path === root || path.startsWith(root + '/'))) throw new Error('input mount uses a reserved path');
  if (project && path.startsWith('/fsx') && path !== source) throw new Error('project FSx input aliases must use their original path or a path outside /fsx');
}

/** Only this trusted init container sees the full PVC. No user command/env/files enter it. */
export function storageLayout(project?: string, image?: string, shared: SharedReadOnlyPath[] = []) {
  const volumes: unknown[] = [{
    name: 'fsx',
    persistentVolumeClaim: {
      claimName: 'fsx-pvc'
    }
  }];
  const mounts: VolumeMount[] = [];
  const initContainers: unknown[] = [];
  if (!project) {
    mounts.push({
      name: 'fsx',
      mountPath: '/fsx'
    });
    return {
      volumes,
      mounts,
      initContainers
    };
  }
  if (!image) throw new Error('trusted runtimeImage is required to prepare project storage');
  const roots = projectRoots(project);
  for (const name of shared) if (!['envs', 'workshop'].includes(name)) throw new Error('unapproved shared storage path');
  mounts.push({
    name: 'fsx',
    mountPath: roots[0],
    subPath: roots[0].slice(5)
  }, {
    name: 'fsx',
    mountPath: roots[1],
    subPath: roots[1].slice(5),
    readOnly: true
  });
  for (const name of new Set(shared)) mounts.push({
    name: 'fsx',
    mountPath: `/fsx/${name}`,
    subPath: name,
    readOnly: true
  });
  const dirs = [...roots.map(root => root.slice(5)), ...new Set(shared)];
  const script = ['set -eu'];
  for (const relative of dirs) {
    // Check every path component before mkdir/chown, including pre-existing parent directories.
    let path = '/pai-fsx';
    for (const component of relative.split('/')) {
      path += '/' + component;
      script.push(`[ ! -L ${shellQuote(path)} ] || exit 125`, `mkdir -p ${shellQuote(path)}`);
    }
    if (relative.startsWith('checkpoints/projects/') || relative.startsWith('datasets/projects/')) script.push(`chown 1000:1000 ${shellQuote(path)}`, `chmod 0770 ${shellQuote(path)}`);
  }
  initContainers.push({
    name: 'pai-storage-prepare',
    image,
    command: ['/bin/sh', '-c', script.join('; ')],
    volumeMounts: [{
      name: 'fsx',
      mountPath: '/pai-fsx'
    }],
    securityContext: {
      runAsUser: 0,
      runAsGroup: 0,
      runAsNonRoot: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: {
        drop: ['ALL'],
        add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE']
      },
      seccompProfile: {
        type: 'RuntimeDefault'
      }
    }
  });
  initContainers.push({
    name: 'pai-isolation-ready',
    image,
    command: ['/opt/pai/runtime', '--verify-isolation'],
    securityContext: {
      runAsUser: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    },
  });
  return {
    volumes,
    mounts,
    initContainers
  };
}
