import { api } from './api-client';
export interface UploadSession {
  id: string;
  filename: string;
  size: number;
  lastModified: number;
  partSize: number;
  partCount: number;
  state: string;
  parts?: {
    number: number;
    size: number;
    checksum: string;
  }[];
}
type Options = {
  request?: (path: string, init?: any) => Promise<any>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  put?: typeof putPart;
  wait?: (ms: number) => Promise<void>;
};
const root = (name: string, version: number) => `/api/datasets/${encodeURIComponent(name)}/versions/${version}/uploads`;
const cacheKey = (name: string, version: number, filename: string) => `pai-multipart:${name}:${version}:${filename}`;
function putPart(url: string, headers: Record<string, string>, data: Blob, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = (error?: Error) => {
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    xhr.open('PUT', url);
    xhr.timeout = 15 * 60_000;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = event => progress(event.loaded);
    xhr.onload = () => done(xhr.status >= 200 && xhr.status < 300 ? undefined : new Error(`업로드 실패: HTTP ${xhr.status}`));
    xhr.onerror = () => done(new Error('업로드 연결 오류'));
    xhr.ontimeout = () => done(new Error('업로드 시간 초과'));
    xhr.onabort = () => done(new DOMException('일시 중지', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      done(new DOMException('일시 중지', 'AbortError'));
      return;
    }
    xhr.send(data);
  });
}
/** Reselecting a file rechecks every existing part against its actual bytes before reuse. */
export async function uploadDatasetFile(name: string, version: number, file: File, filename: string, progress: (percent: number) => void, signal: AbortSignal, options: Options = {}) {
  const request = options.request ?? api,
    storage = options.storage ?? localStorage,
    put = options.put ?? putPart,
    wait = options.wait ?? (ms => new Promise(r => setTimeout(r, ms)));
  const key = cacheKey(name, version, filename),
    base = root(name, version);
  let saved: {
    id: string;
  } | undefined;
  try {
    saved = JSON.parse(storage.getItem(key) ?? 'null') ?? undefined;
  } catch {/* storage is optional */}
  const retry = async <T,>(operation: () => Promise<T>) => {
    for (let n = 0;; n++) {
      signal.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        if (signal.aborted || n === 2 || (error as {
          status?: number;
        }).status === 403) throw error;
        await wait(250 * 2 ** n);
      }
    }
  };
  const start = () => retry<UploadSession>(() => request(base, { method: 'POST', json: { filename, size: file.size, lastModified: file.lastModified, contentType: file.type || 'application/octet-stream' }, signal }));
  let session: UploadSession;
  try {
    session = saved ? await request(`${base}/${saved.id}`, { signal }) : await start();
  } catch (error) {
    if ((error as {
      status?: number;
    }).status !== 404) throw error;
    session = await start();
  }
  if (session.state === 'CREATING' || session.state === 'ABORTED') session = await start();
  if (session.size !== file.size || session.lastModified !== file.lastModified || !Number.isInteger(session.partCount) || session.partCount < 1 || session.partCount > 10000 || session.partSize < 1 || session.partCount !== Math.ceil(file.size / session.partSize)) throw new Error('선택한 파일이 업로드 세션과 다릅니다.');
  try {
    storage.setItem(key, JSON.stringify({ id: session.id }));
  } catch {/* reselect can find the server reservation */}
  session = await retry<UploadSession>(() => request(`${base}/${session.id}`, { signal }));
  const existing = new Map(session.parts?.map(part => [part.number, part]) ?? []),
    checksums: string[] = [];
  let completed = 0;
  for (let partNumber = 1; partNumber <= session.partCount; partNumber++) {
    signal.throwIfAborted();
    const data = file.slice((partNumber - 1) * session.partSize, Math.min(file.size, partNumber * session.partSize));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await data.arrayBuffer()));
    const sha = btoa(String.fromCharCode(...digest));
    checksums.push(sha);
    const prior = existing.get(partNumber);
    if (session.state === 'UPLOADING' && (!prior || prior.size !== data.size || prior.checksum !== sha)) await retry(async () => {
      const signed = await request(`${base}/${session.id}`, { method: 'POST', json: { action: 'part', partNumber, checksumSHA256: sha }, signal });
      await put(signed.url, signed.headers, data, signal, bytes => progress(Math.min(99, Math.floor((completed + bytes) / file.size * 99))));
    });
    completed += data.size;
    progress(Math.min(99, Math.floor(completed / file.size * 99)));
  }
  signal.throwIfAborted();
  const result = await retry<UploadSession>(() => request(`${base}/${session.id}`, { method: 'POST', json: { action: 'complete', checksums }, signal }));
  if (result.state !== 'COMPLETED') throw new Error('서버에서 업로드 완료를 확인하지 못했습니다.');
  try {
    storage.removeItem(key);
  } catch {/* metadata contains no credentials */}
  progress(100);
}
export async function abortDatasetUpload(name: string, version: number, session: Pick<UploadSession, 'id' | 'filename'>) {
  const result = await api<UploadSession>(`${root(name, version)}/${session.id}`, { method: 'DELETE' });
  if (!['ABORTED', 'COMPLETED'].includes(result.state)) throw new Error('업로드 중단을 아직 확인하지 못했습니다.');
  try {
    localStorage.removeItem(cacheKey(name, version, session.filename));
  } catch {/* optional cache */}
}
