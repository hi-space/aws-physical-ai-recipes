import { route } from '@/server/api';
import { config } from '@/server/config';
import * as s3 from '@/server/aws/s3';
import * as sm from '@/server/aws/sagemaker';
import * as ml from '@/server/aws/mlflow';
import { getRepo } from '@/server/store/repo';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => {
  const c = config();
  const safe = async <T,>(p: Promise<T>, fb: T) => p.catch(() => fb);
  const [smModels, eksCheckpoints, packages, mlModels, datasets] = await Promise.all([
    c.groot ? safe(s3.list(c.groot.artifactsBucket, 'models/groot-sm/'), undefined) : undefined,
    c.eks ? safe(s3.list(c.eks.dataBucket, 'checkpoints/'), undefined) : undefined,
    safe(sm.listModelPackages(), []),
    c.groot?.mlflowTrackingServerArn ? safe(ml.searchRegisteredModels(), []) : [],
    getRepo().listDatasets(),
  ]);
  return {
    sagemakerModels: smModels ? { bucket: smModels.bucket, entries: smModels.entries.filter((e) => e.isPrefix) } : undefined,
    eksCheckpoints: eksCheckpoints ? { bucket: eksCheckpoints.bucket, entries: eksCheckpoints.entries.filter((e) => e.isPrefix) } : undefined,
    modelPackages: packages,
    mlflowModels: mlModels,
    checkpointDatasets: datasets.filter((d) => /ckpt|checkpoint|model/.test(d.name)),
  };
});
