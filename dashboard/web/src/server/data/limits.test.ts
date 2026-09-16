import { expect, it } from 'vitest';
import { assertConsumableObjects, assertTaskInputBudget, MAX_MANIFEST_BYTES } from './limits';
const object = { path: 'file', key: 'projects/a/v1/file', versionId: 'v1', bytes: 1, checksumSHA256: Buffer.alloc(32).toString('base64'), checksumType: 'FULL_OBJECT' };
it('rejects manifests that the runtime cannot hydrate, including aggregate response size', () => {
  expect(() => assertConsumableObjects(Array.from({length:1025},(_,i)=>({...object,path:String(i)})))).toThrow(/1024/);
  expect(() => assertConsumableObjects([object],MAX_MANIFEST_BYTES+1)).toThrow(/2 MiB/);
  expect(() => assertTaskInputBudget(Array(65).fill(100))).toThrow(/64/);
  expect(() => assertTaskInputBudget([1500000,1500000])).toThrow(/response/);
  expect(assertConsumableObjects([object])).toBeGreaterThan(0);
});
it('refuses file/directory conflicts that the Go hydrator cannot materialize',()=>{
  expect(()=>assertConsumableObjects([object,{...object,path:'file/child'}])).toThrow(/conflict/);
});
it('accepts 1024 small files with paginated URLs but rejects aggregate overflow across datasets',()=>{
 const objects=Array.from({length:1024},(_,i)=>({...object,path:`file-${i}`}));
 expect(()=>assertConsumableObjects(objects)).not.toThrow();
 expect(()=>assertTaskInputBudget([1000,1000],[600,500])).toThrow(/across all datasets/);
 expect(()=>assertConsumableObjects([{...object,bytes:1024**4+1}])).toThrow(/1 TiB/);
});
