import { expect, it } from 'vitest';
import { thumbnailFit } from './ArtifactViewer';

it('crops only extreme aspect ratios in gallery tiles', () => {
  expect(thumbnailFit(640, 480)).toBe('object-contain');
  expect(thumbnailFit(1200, 3600)).toBe('object-cover object-top');
  expect(thumbnailFit(4000, 400)).toBe('object-cover object-left');
  expect(thumbnailFit(0, 0)).toBe('object-contain');
});
