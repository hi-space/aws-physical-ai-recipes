/** Public admission contract. Keep Go limits.go in sync; never truncate plans. */
export const RUNTIME_LIMITS = {
  files: 1024, groups: 64, pageFiles: 64, metadataBytes: 300_000,
  responseBytes: 2 * 1024 ** 2, pathBytes: 1024,
  fileBytes: 1024 ** 4, singlePutBytes: 64 * 1024 ** 2,
  minimumPartBytes: 5 * 1024 ** 2, maximumPartBytes: 5 * 1024 ** 3, parts: 10_000,
} as const;
export function multipartLayout(size: number) {
  const partSize = Math.max(64 * 1024 ** 2, Math.ceil(size / RUNTIME_LIMITS.parts / 1024 ** 2) * 1024 ** 2);
  return { partSize, partCount: Math.ceil(size / partSize) };
}
