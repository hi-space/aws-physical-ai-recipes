import { safeDataPath } from './selection';
import { badRequest } from '../errors';
import { RUNTIME_LIMITS } from '../runtime/limits';
/** Shared with the broker/Go paginated input-plan protocol. */
export const MAX_MANIFEST_BYTES = RUNTIME_LIMITS.responseBytes;
export const MAX_INPUT_OBJECTS = RUNTIME_LIMITS.files;
export const MAX_TASK_INPUTS = RUNTIME_LIMITS.groups;
export const MAX_INPUT_FILE_BYTES = RUNTIME_LIMITS.fileBytes;
export function assertConsumableObjects(objects: {path:string;key?:string;bytes:number;versionId:string;checksumSHA256:string;checksumType?:string}[], manifestBytes = 0): number {
  if (!objects.length || objects.length > MAX_INPUT_OBJECTS) throw badRequest('Runtime input requires 1–1024 files; select a smaller version');
  if (manifestBytes > MAX_MANIFEST_BYTES) throw badRequest('Runtime manifest exceeds 2 MiB; select a smaller version');
  const paths=new Set<string>();
  for(const object of objects) {
    if(!safeDataPath(object.path)||paths.has(object.path)||!Number.isSafeInteger(object.bytes)||object.bytes<0||object.bytes>MAX_INPUT_FILE_BYTES)throw badRequest('Runtime input contains an unsafe path, duplicate or size outside 0–1 TiB');
    paths.add(object.path);
  }
  for(const path of paths) {const parts=path.split('/');parts.pop();while(parts.length){if(paths.has(parts.join('/')))throw badRequest('Runtime input has a file/directory conflict');parts.pop();}}
  // Broker fingerprints metadata including bucket/key before selecting a 64-file
  // page. URLs are added to that page only and are not an aggregate-plan limit.
  const bytes = objects.reduce((total,o)=>total+Buffer.byteLength(JSON.stringify({path:o.path,size:o.bytes,versionId:o.versionId,
    checksumSHA256:o.checksumSHA256,checksumType:o.checksumType,key:o.key??'',bucket:'x'.repeat(63)}))+1,4096);
  assertTaskInputBudget([bytes],[objects.length]);
  return bytes;
}
export function assertTaskInputBudget(inputBytes: number[], objectCounts: number[] = []): void {
  if(inputBytes.some(n=>!Number.isSafeInteger(n)||n<0)||objectCounts.some(n=>!Number.isSafeInteger(n)||n<0))throw badRequest('Invalid runtime input byte/file budget');
  if (inputBytes.length > MAX_TASK_INPUTS) throw badRequest('Runtime accepts at most 64 dataset inputs per task');
  if (objectCounts.reduce((sum,n)=>sum+n,0)>MAX_INPUT_OBJECTS) throw badRequest('Runtime task input plan exceeds 1024 files across all datasets');
  if (inputBytes.reduce((sum,n)=>sum+n,256) > MAX_MANIFEST_BYTES) throw badRequest('Runtime input response metadata exceeds 2 MiB; select fewer files/inputs');
}
