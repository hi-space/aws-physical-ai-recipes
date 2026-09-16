import { badRequest } from '../errors';
import type { TaskImagePins } from '../store/types';
import type { WorkflowSpec } from './schema';

const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

/** Structural checks only. The parent's binding/launch policy owns approvals. */
export function applyTrustedImagePins(spec: WorkflowSpec, supplied?: TaskImagePins): TaskImagePins | undefined {
  if (supplied === undefined) return;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw badRequest('Invalid trusted image pins');
  const names = new Set(spec.workflow.tasks.map(task => task.name));
  const pins: TaskImagePins = Object.create(null);
  for (const [name, pin] of Object.entries(supplied)) {
    if (!names.has(name)) throw badRequest('Image pin references an unknown task');
    if (!pin || typeof pin !== 'object' ||
      typeof pin.image !== 'string' || pin.image.length > 1024 || /[\x00-\x20\x7f]/.test(pin.image) || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(pin.image) ||
      typeof pin.profileId !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(pin.profileId) ||
      !Number.isSafeInteger(pin.profileVersion) || pin.profileVersion < 1 || !timestamp(pin.checkedAt)) {
      throw badRequest('Image pins require an immutable digest, profile ID/version and checkedAt timestamp');
    }
    pins[name] = { image: pin.image, profileId: pin.profileId, profileVersion: pin.profileVersion, checkedAt: pin.checkedAt };
  }
  if (!Object.keys(pins).length) return;
  for (const task of spec.workflow.tasks) if (Object.hasOwn(pins, task.name)) task.image = pins[task.name].image;
  // Synchronize image values before hashing without changing the historical
  // normalization/hash shape of legacy groups with no pins.
  for (const group of spec.workflow.groups ?? []) for (const task of group.tasks) {
    if (Object.hasOwn(pins, task.name)) task.image = pins[task.name].image;
  }
  return pins;
}

export function validatePreflightReview(by?: string, at?: string): void {
  if (by !== undefined && (typeof by !== 'string' || !by.trim() || by.length > 256 || /[\x00-\x1f\x7f]/.test(by))) {
    throw badRequest('Invalid trusted preflight reviewer');
  }
  if (at !== undefined && !timestamp(at)) throw badRequest('Invalid trusted preflight review timestamp');
}

/** Inspection/review timestamps are audit data, not a new submission identity. */
export function imagePinBindings(pins?: TaskImagePins) {
  return pins && Object.fromEntries(Object.entries(pins).map(([task, pin]) =>
    [task, { image: pin.image, profileId: pin.profileId, profileVersion: pin.profileVersion }]));
}
