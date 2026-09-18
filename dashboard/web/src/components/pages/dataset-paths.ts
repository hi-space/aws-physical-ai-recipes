/** The API takes a version-relative prefix, while S3 returns full object keys. */
export function datasetRelativePrefix(key: string, uri: string): string {
  const match = /^s3:\/\/[^/]+\/?(.*)$/.exec(uri);
  if (!match) throw new Error('Cannot determine the S3 dataset path.');
  const root = match[1] ? `${match[1].replace(/\/+$/, '')}/` : '';
  if (!key.startsWith(root)) throw new Error('The folder is outside the selected dataset version.');
  return key.slice(root.length);
}

export function datasetUploadFilename(prefix: string, filename: string): string {
  return prefix ? `${prefix.replace(/\/+$/, '')}/${filename}` : filename;
}
