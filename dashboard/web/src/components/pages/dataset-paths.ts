/** The API takes a version-relative prefix, while S3 returns full object keys. */
export function datasetRelativePrefix(key: string, uri: string): string {
  const match = /^s3:\/\/[^/]+\/?(.*)$/.exec(uri);
  if (!match) throw new Error('S3 데이터셋 경로를 확인할 수 없습니다.');
  const root = match[1] ? `${match[1].replace(/\/+$/, '')}/` : '';
  if (!key.startsWith(root)) throw new Error('선택한 데이터셋 버전 밖의 폴더입니다.');
  return key.slice(root.length);
}

export function datasetUploadFilename(prefix: string, filename: string): string {
  return prefix ? `${prefix.replace(/\/+$/, '')}/${filename}` : filename;
}
