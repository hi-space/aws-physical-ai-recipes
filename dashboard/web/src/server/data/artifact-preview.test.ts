import { expect, it } from 'vitest';
import { MAX_INLINE_TEXT_BYTES, contentTypeFor, inlinePreviewable, previewKind } from './artifact-preview';

it('classifies evaluation plots, videos, reports and weights the way the viewer renders them', () => {
  expect(previewKind('evaluation/plots/traj_0.jpeg')).toBe('image');
  expect(previewKind('videos/episode-0000.mp4')).toBe('video');
  expect(previewKind('evaluation.json')).toBe('json');
  expect(previewKind('model-card.md')).toBe('text');
  expect(previewKind('modality_config.py')).toBe('text');
  expect(previewKind('model.safetensors')).toBe('other');
  expect(previewKind('checkpoint-300/optimizer.pt')).toBe('other');
  expect(previewKind('no-extension')).toBe('other');
});

it('overrides the stored octet-stream content type so browsers render media inline', () => {
  expect(contentTypeFor('a/b.MP4')).toBe('video/mp4');
  expect(contentTypeFor('plot.JPG')).toBe('image/jpeg');
  expect(contentTypeFor('report.json')).toBe('application/json');
  expect(contentTypeFor('notes.md')).toBe('text/markdown; charset=utf-8');
  expect(contentTypeFor('weights.bin')).toBe('application/octet-stream');
});

it('streams media of any size but only fetches bounded text into the page', () => {
  expect(inlinePreviewable('big.mp4', 5 * 1024 ** 3)).toBe(true);
  expect(inlinePreviewable('evaluation.json', MAX_INLINE_TEXT_BYTES)).toBe(true);
  expect(inlinePreviewable('trainer_state.json', MAX_INLINE_TEXT_BYTES + 1)).toBe(false);
  expect(inlinePreviewable('model.zip', 10)).toBe(false);
});
