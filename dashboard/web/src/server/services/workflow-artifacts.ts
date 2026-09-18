import { pinnedDatasetManifest } from '../data/versions';
import { MAX_LISTED_FILES, inlinePreviewable, previewKind, type PreviewKind } from '../data/artifact-preview';
import { HttpError, notFound } from '../errors';
import type { Repo } from '../store/repo';
import type { TaskPhase } from '../store/types';

export interface ArtifactFile { path: string; bytes: number; kind: PreviewKind; previewable: boolean }
export interface ArtifactVersion {
  dataset: string; version: number; uri: string;
  /** `ready` = files come from the pinned, hash-verified manifest; `unavailable` explains why not. */
  state: 'ready' | 'unavailable';
  message?: string;
  manifestHash?: string;
  fileCount: number; sizeBytes: number; mediaCount: number;
  files: ArtifactFile[]; truncated: boolean;
}
export interface ArtifactTask { task: string; phase: TaskPhase; attempt: number; outputPath?: string; versions: ArtifactVersion[] }
export interface WorkflowArtifacts { workflowId: string; status: string; tasks: ArtifactTask[]; mediaCount: number; fileCount: number }

const LEGACY_MESSAGE = '이 출력은 검증된 manifest 없이 게시된 구버전 결과입니다. Datasets 페이지에서 원본 S3 경로를 확인하세요.';

function unavailable(dataset: string, version: number, uri: string, message: string): ArtifactVersion {
  return { dataset, version, uri, state: 'unavailable', message, fileCount: 0, sizeBytes: 0, mediaCount: 0, files: [], truncated: false };
}

async function describeVersion(repo: Repo, projectId: string | undefined, dataset: string, version: number, signal?: AbortSignal): Promise<ArtifactVersion> {
  const v = await repo.getVersion(dataset, version);
  if (!v) return unavailable(dataset, version, '', '데이터셋 버전 기록을 찾을 수 없습니다.');
  if ((v.projectId ?? '') !== (projectId ?? '')) return unavailable(dataset, version, v.uri, '다른 프로젝트에 속한 버전입니다.');
  if (v.state !== 'READY' || !v.manifestUri || !v.manifestHash) return unavailable(dataset, version, v.uri, v.state === 'PENDING' ? '게시 검증이 아직 진행 중입니다.' : LEGACY_MESSAGE);
  try {
    const snap = await pinnedDatasetManifest(repo, dataset, version, signal);
    const objects = [...snap.manifest.objects].sort((a, b) => a.path.localeCompare(b.path));
    const files = objects.slice(0, MAX_LISTED_FILES).map((o): ArtifactFile => ({ path: o.path, bytes: o.bytes, kind: previewKind(o.path), previewable: inlinePreviewable(o.path, o.bytes) }));
    return {
      dataset, version, uri: v.uri, state: 'ready', manifestHash: snap.hash,
      fileCount: objects.length, sizeBytes: objects.reduce((sum, o) => sum + o.bytes, 0),
      mediaCount: objects.filter(o => ['image', 'video'].includes(previewKind(o.path))).length,
      files, truncated: objects.length > files.length,
    };
  } catch (error) {
    // 4xx = a verification statement safe to show; anything else stays generic (S3 outage, permissions).
    const message = error instanceof HttpError && error.status < 500 ? error.message : 'manifest를 읽지 못했습니다. 잠시 후 다시 시도하세요.';
    if (!(error instanceof HttpError)) console.error('[artifacts] manifest read failed', dataset, version, (error as Error).name);
    return unavailable(dataset, version, v.uri, message);
  }
}

/** Read-only view of everything a workflow's tasks published, resolved through the pinned manifests. */
export async function listWorkflowArtifacts(repo: Repo, workflowId: string, signal?: AbortSignal): Promise<WorkflowArtifacts> {
  const workflow = await repo.getWorkflow(workflowId);
  if (!workflow) throw notFound(`workflow ${workflowId}`);
  const tasks = (await repo.listTasks(workflowId)).filter(t => t.publishedVersions?.length);
  const described: ArtifactTask[] = [];
  for (const task of tasks) {
    const versions: ArtifactVersion[] = [];
    for (const published of task.publishedVersions ?? []) versions.push(await describeVersion(repo, workflow.projectId, published.dataset, published.version, signal));
    described.push({ task: task.name, phase: task.phase, attempt: task.attempts, outputPath: task.outputPath, versions });
  }
  const all = described.flatMap(t => t.versions);
  return {
    workflowId, status: workflow.status, tasks: described,
    mediaCount: all.reduce((sum, v) => sum + v.mediaCount, 0),
    fileCount: all.reduce((sum, v) => sum + v.fileCount, 0),
  };
}
