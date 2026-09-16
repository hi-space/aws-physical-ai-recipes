import {
  CreateDataRepositoryTaskCommand,
  DescribeDataRepositoryAssociationsCommand,
  DescribeDataRepositoryTasksCommand,
  DescribeFileSystemsCommand,
} from '@aws-sdk/client-fsx';
import { config } from '../config';
import { badRequest } from '../errors';
import { fsx } from './clients';

export function knownFileSystems(): { id: string; label: string }[] {
  const c = config();
  const out: { id: string; label: string }[] = [];
  if (c.eks?.fsxFileSystemId) out.push({ id: c.eks.fsxFileSystemId, label: 'HyperPod EKS /fsx' });
  if (c.slurm?.fsxFileSystemId) out.push({ id: c.slurm.fsxFileSystemId, label: 'HyperPod Slurm /fsx' });
  return out;
}

export async function describeAll() {
  const ids = knownFileSystems().map((f) => f.id);
  if (!ids.length) return [];
  const [fs, dra] = await Promise.all([
    fsx().send(new DescribeFileSystemsCommand({ FileSystemIds: ids })),
    fsx().send(new DescribeDataRepositoryAssociationsCommand({ Filters: [{ Name: 'file-system-id', Values: ids }] })),
  ]);
  return (fs.FileSystems ?? []).map((f) => ({
    id: f.FileSystemId!,
    label: knownFileSystems().find((k) => k.id === f.FileSystemId)?.label ?? f.FileSystemId!,
    lifecycle: f.Lifecycle,
    storageCapacityGiB: f.StorageCapacity,
    dnsName: f.DNSName,
    mountName: f.LustreConfiguration?.MountName,
    deploymentType: f.LustreConfiguration?.DeploymentType,
    throughputPerTiB: f.LustreConfiguration?.PerUnitStorageThroughput,
    associations: (dra.Associations ?? [])
      .filter((a) => a.FileSystemId === f.FileSystemId)
      .map((a) => ({
        id: a.AssociationId,
        fileSystemPath: a.FileSystemPath,
        dataRepositoryPath: a.DataRepositoryPath,
        lifecycle: a.Lifecycle,
        autoImport: a.S3?.AutoImportPolicy?.Events ?? [],
        autoExport: a.S3?.AutoExportPolicy?.Events ?? [],
      })),
  }));
}

export function assertKnownFileSystem(id: string): void {
  if (!knownFileSystems().some((f) => f.id === id)) throw badRequest(`file system ${id} is not managed by this dashboard`);
}

export async function listTasks(fileSystemId: string) {
  assertKnownFileSystem(fileSystemId);
  const out = await fsx().send(new DescribeDataRepositoryTasksCommand({ Filters: [{ Name: 'file-system-id', Values: [fileSystemId] }], MaxResults: 20 }));
  return (out.DataRepositoryTasks ?? []).sort((a, b) => (b.CreationTime?.getTime() ?? 0) - (a.CreationTime?.getTime() ?? 0));
}

export async function createTask(fileSystemId: string, type: 'EXPORT_TO_REPOSITORY' | 'IMPORT_METADATA_FROM_REPOSITORY', paths: string[]) {
  assertKnownFileSystem(fileSystemId);
  for (const p of paths) if (!p.startsWith('/') || p.includes('..')) throw badRequest(`invalid path ${p}`);
  const out = await fsx().send(
    new CreateDataRepositoryTaskCommand({
      FileSystemId: fileSystemId,
      Type: type,
      Paths: paths.map((p) => p.replace(/^\/fsx\/?/, '')),
      Report: { Enabled: false },
    }),
  );
  return out.DataRepositoryTask;
}
