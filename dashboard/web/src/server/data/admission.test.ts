import {expect,it,vi} from 'vitest';
const {validate}=vi.hoisted(()=>({validate:vi.fn(async()=>{throw new Error('manifest exceeds runtime response budget');})}));
vi.mock('./versions',()=>({validateDatasetInputs:validate}));
import {getRepo} from '../store/repo';
import type {Workflow} from '../store/types';
it('production repository factory validates full project input manifests before any workflow or dispatch write',async()=>{
 vi.stubEnv('AUTH_MODE','dev');vi.stubEnv('TABLE_NAME','');
 const repo=getRepo();
 const wf={id:'reject-before-submit',projectId:'p',spec:{workflow:{tasks:[{inputs:[{dataset:{name:'data',version:1}}]}]}}} as unknown as Workflow;
 await expect(repo.createWorkflow(wf,[])).rejects.toThrow(/runtime response budget/);
 expect(validate).toHaveBeenCalledWith(repo,wf);
 expect(await repo.getWorkflow(wf.id)).toBeUndefined();expect(await repo.listOutbox(wf.id)).toEqual([]);
});
