import { describe, expect, it } from 'vitest';
import { datasetRelativePrefix, datasetUploadFilename } from './dataset-paths';

describe('dataset browser paths', () => {
  it('turns an S3 folder key into a prefix relative to the selected version', () => {
    expect(datasetRelativePrefix('datasets/demo/v1/images/front/', 's3://bucket/datasets/demo/v1/')).toBe('images/front/');
    expect(datasetRelativePrefix('datasets/demo/v1/', 's3://bucket/datasets/demo/v1/')).toBe('');
  });
  it('rejects a folder outside the version instead of silently browsing another prefix', () => {
    expect(() => datasetRelativePrefix('datasets/demo/v10/images/', 's3://bucket/datasets/demo/v1/')).toThrow();
  });
  it('uploads to the current relative folder and preserves the root upload case', () => {
    expect(datasetUploadFilename('images/front/', 'frame.png')).toBe('images/front/frame.png');
    expect(datasetUploadFilename('', 'frame.png')).toBe('frame.png');
  });
});
