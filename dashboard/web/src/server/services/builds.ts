import { createHash, randomUUID } from 'node:crypto';
import { CodeBuildClient, BatchGetBuildsCommand, ListBuildsForProjectCommand, StartBuildCommand, BatchGetProjectsCommand } from '@aws-sdk/client-codebuild';
import { config } from '../config';
import { badRequest } from '../errors';
import { getRepo } from '../store/repo';

const client = () => new CodeBuildClient({ region: config().region });
export const allowedBuildProjects = () => (process.env.BUILD_PROJECTS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
function assertProject(name: string) { if (!allowedBuildProjects().includes(name)) throw badRequest('등록되지 않은 빌드 프로젝트입니다.'); }
export async function listBuildProjects() {
  const names = allowedBuildProjects();
  if (!names.length) return [];
  const projects = await client().send(new BatchGetProjectsCommand({ names }));
  return (projects.projects ?? []).map((project) => ({ name: project.name, description: project.description, sourceType: project.source?.type, timeoutMinutes: project.timeoutInMinutes }));
}
export async function listBuilds(project: string) {
  assertProject(project);
  const ids = await client().send(new ListBuildsForProjectCommand({ projectName: project, sortOrder: 'DESCENDING' }));
  if (!ids.ids?.length) return [];
  const response = await client().send(new BatchGetBuildsCommand({ ids: ids.ids.slice(0, 30) }));
  return (response.builds ?? []).map((build) => ({
    id: build.id, project: build.projectName, status: build.buildStatus, phase: build.currentPhase,
    startedAt: build.startTime?.toISOString(), finishedAt: build.endTime?.toISOString(),
    sourceVersion: build.sourceVersion, resolvedSourceVersion: build.resolvedSourceVersion,
    logGroup: build.logs?.groupName, logStream: build.logs?.streamName,
    phases: build.phases?.map((phase) => ({ phase: phase.phaseType, status: phase.phaseStatus, duration: phase.durationInSeconds })),
  }));
}
export async function startBuild(project: string, actor: string, requestId: string = randomUUID()) {
  assertProject(project);
  const idempotencyToken = createHash('sha256').update(`${actor}:${project}:${requestId}`).digest('hex');
  const response = await client().send(new StartBuildCommand({ projectName: project, idempotencyToken }));
  const build = response.build!;
  await getRepo().kv.put({ pk: `BUILD#${build.id}`, sk: 'META', actor, project, startedAt: new Date().toISOString(), idempotencyToken });
  return { id: build.id, status: build.buildStatus, project };
}
