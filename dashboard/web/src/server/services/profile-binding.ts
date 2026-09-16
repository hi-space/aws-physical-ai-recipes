import type { Session } from '../auth/session';
import type { Project } from '../auth/projects';
import { HttpError } from '../errors';
import { getRepo } from '../store/repo';
import type { Workflow } from '../store/types';
import type { TaskSpec, WorkflowSpec } from '../workflow/schema';
import { imageProfilesService, type ImagePreflight, type ImageProfile } from './image-profiles';

export interface ImagePin { image: string; profileId: string; profileVersion: number; checkedAt: string }
export const profilesRequired = () => process.env.IMAGE_PROFILES_ENFORCED === '1';

export async function inspectWorkflowImages(session: Session, spec: WorkflowSpec, project: Project) {
  return imageProfilesService(session).preflight(spec, project);
}
export function acceptedImagePins(preflight: ImagePreflight, acknowledged: boolean): Record<string, ImagePin> {
  if (preflight.status === 'blocked') throw new HttpError(422, '승인된 이미지와 실행 자원 조건을 확인하세요.', 'image_preflight_blocked', { findings: preflight.findings });
  if (!acknowledged) throw new HttpError(428, '실행 환경의 검토 항목을 확인한 뒤 제출하세요.', 'image_preflight_review', { findings: preflight.findings });
  const pins: Record<string, ImagePin> = {};
  for (const task of preflight.tasks) {
    const image = preflight.resolvedImageDigests[task.task];
    if (!image || !task.profileId || !task.profileVersion) throw new HttpError(422, '이미지 승인 정보를 고정하지 못했습니다.');
    pins[task.task] = { image, profileId: task.profileId, profileVersion: task.profileVersion, checkedAt: preflight.checkedAt };
  }
  return pins;
}
/** Queueing never preserves permission to launch an image after approval withdrawal. */
export async function validateTaskImagePolicy(workflow: Workflow & { imagePins?: Record<string, ImagePin> }, task: TaskSpec) {
  const pin = workflow.imagePins?.[task.name];
  if (!pin) return; // Older accepted runs retain their original execution contract.
  const pk = `PROJECT#${workflow.projectId}`;
  const head = await getRepo().kv.get(pk, `IMAGE_PROFILE#${pin.profileId}`);
  const revision = await getRepo().kv.get(pk, `IMAGE_PROFILE_REV#${pin.profileId}#${String(pin.profileVersion).padStart(8, '0')}`) as unknown as ImageProfile | undefined;
  if (!head || head.enabled === false || Number(head.version) !== pin.profileVersion || !revision?.approved ||
    revision.projectId !== workflow.projectId || revision.image.resolvedImage !== pin.image || task.image !== pin.image) {
    throw new HttpError(409, '이미지 승인이 변경되어 작업을 시작하지 않았습니다. 현재 프로필을 확인한 뒤 다시 제출하세요.', 'image_approval_changed');
  }
}
