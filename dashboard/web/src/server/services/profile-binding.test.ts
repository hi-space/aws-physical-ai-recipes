import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryKV } from '../store/dynamo';
import { Repo } from '../store/repo';
import type { Workflow } from '../store/types';
import type { TaskSpec } from '../workflow/schema';
import type { ImagePreflight } from './image-profiles';
const fixture = vi.hoisted(() => ({ repo: undefined as unknown as Repo }));
vi.mock('../store/repo', async (original) => ({ ...await original<typeof import('../store/repo')>(), getRepo: () => fixture.repo }));
import { acceptedImagePins, validateTaskImagePolicy } from './profile-binding';

const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/test@sha256:${'a'.repeat(64)}`;
const check = { projectId: 'lab', checkedAt: '2026-09-16T00:00:00Z', status: 'needs-review', resolvedImageDigests: { train: image }, tasks: [{ task: 'train', profileId: 'approved', profileVersion: 1 }], findings: [] } as unknown as ImagePreflight;
beforeEach(() => { fixture.repo = new Repo(new MemoryKV()); });
it('requires explicit review and never bypasses a blocked inspection', () => {
  expect(() => acceptedImagePins(check, false)).toThrow(/검토 항목/);
  expect(() => acceptedImagePins({ ...check, status: 'blocked' }, true)).toThrow(/승인된 이미지/);
  expect(acceptedImagePins(check, true).train.image).toBe(image);
});
it('prevents missing task pins from becoming an accepted execution', () => {
  expect(() => acceptedImagePins({ ...check, resolvedImageDigests: {} }, true)).toThrow(/고정하지 못했습니다/);
});
it('rechecks the approved revision immediately before a queued task launches', async () => {
  const wf = { projectId: 'lab', imagePins: acceptedImagePins(check, true) } as unknown as Workflow;
  const task = { name: 'train', image } as TaskSpec;
  await fixture.repo.kv.put({ pk: 'PROJECT#lab', sk: 'IMAGE_PROFILE#approved', version: 1, enabled: true });
  await fixture.repo.kv.put({ pk: 'PROJECT#lab', sk: 'IMAGE_PROFILE_REV#approved#00000001', projectId: 'lab', approved: true, image: { resolvedImage: image } });
  await expect(validateTaskImagePolicy(wf, task)).resolves.toBeUndefined();
  await fixture.repo.kv.put({ pk: 'PROJECT#lab', sk: 'IMAGE_PROFILE#approved', version: 2, enabled: true });
  await expect(validateTaskImagePolicy(wf, task)).rejects.toMatchObject({ status: 409 });
});
