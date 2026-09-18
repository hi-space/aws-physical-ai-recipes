import { StopTrainingJobCommand } from '@aws-sdk/client-sagemaker';
import { badRequest } from '../errors';
import { sagemaker } from './clients';

/**
 * Stop one SageMaker training job started by the GR00T pipeline. IAM only allows jobs named `pipelines-*`
 * (SageMaker's naming for pipeline-created jobs), so anything else is rejected here with a clear message.
 */
export async function stopPipelineTrainingJob(name: string): Promise<void> {
  if (!/^pipelines-[A-Za-z0-9-]{1,120}$/.test(name)) throw badRequest('Only training jobs created by the pipeline (pipelines-…) can be stopped here');
  await sagemaker().send(new StopTrainingJobCommand({ TrainingJobName: name }));
}
