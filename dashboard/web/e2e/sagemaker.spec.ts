import { writeFile } from 'node:fs/promises';
import { test, expect, budgets } from './researcher-helpers/fixture';

test('GR00T SageMaker quick pipeline trains and verifies model loading on AWS', async ({ researcher }, info) => {
  test.setTimeout(60 * 60_000);
  const data = await researcher.api<{ pipeline: { parameters: Array<{ Name: string }> } }>('GET', '/api/pipelines');
  // Preserve the workshop's configured instance and GPU topology.
  const wanted: Record<string, string> = { MaxSteps: '100', GlobalBatchSize: '4', SaveSteps: '50' };
  if (process.env.PAI_SM_INSTANCE_TYPE) wanted.InstanceType = process.env.PAI_SM_INSTANCE_TYPE;
  if (process.env.PAI_SM_NUM_GPUS) wanted.NumGpus = process.env.PAI_SM_NUM_GPUS;
  const parameters = Object.fromEntries(Object.entries(wanted).filter(([name]) => data.pipeline.parameters.some((parameter) => parameter.Name === name)));
  const result = await researcher.api<{ arn: string; operationId: string }>('POST', '/api/pipelines/executions', {
    parameters, displayName: `pai-quick-${researcher.tag}`,
  }, [202], budgets.api, { 'idempotency-key': `pai-quick-${researcher.tag}` });
  expect(result.arn).toMatch(/^arn:aws:sagemaker:us-east-1:/);
  console.log(`[sagemaker] execution=${result.arn}`);
  await writeFile('/tmp/physical-ai-sagemaker-validation.json', JSON.stringify({ ...result, parameters, project: researcher.project.id }, null, 2), { mode: 0o600 });
  let terminal = false;
  try {
    let last = '';
    const detail = await researcher.poll('SageMaker quick pipeline', 55 * 60_000, async (remaining) => {
      const value = await researcher.api<{ execution: { PipelineExecutionStatus: string }; steps: Array<{ StepName: string; StepStatus: string; Metadata?: { TrainingJob?: { Arn: string }; RegisterModel?: { Arn: string } } }> }>('GET', `/api/pipelines/executions/${encodeURIComponent(result.arn)}`, undefined, [200], remaining);
      const state = `${value.execution.PipelineExecutionStatus} ${value.steps.map((step) => `${step.StepName}:${step.StepStatus}`).join(' ')}`;
      if (state !== last) { console.log(`[sagemaker] ${state}`); last = state; }
      return value;
    }, (value) => ['Succeeded', 'Failed', 'Stopped'].includes(value.execution.PipelineExecutionStatus), (value) => value.execution.PipelineExecutionStatus);
    terminal = true;
    await info.attach('sagemaker-execution', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ arn: result.arn, parameters, status: detail.execution.PipelineExecutionStatus, steps: detail.steps }, null, 2)) });
    expect(detail.execution.PipelineExecutionStatus).toBe('Succeeded');
    expect(detail.steps.some((step) => step.StepName === 'GR00TFinetune' && step.StepStatus === 'Succeeded')).toBe(true);
    expect(detail.steps.some((step) => step.StepName === 'SmokeEval' && step.StepStatus === 'Succeeded')).toBe(true);
    expect(detail.steps.some((step) => step.Metadata?.RegisterModel?.Arn)).toBe(true);
  } finally {
    if (!terminal) {
      await researcher.api('DELETE', `/api/pipelines/executions/${encodeURIComponent(result.arn)}`, undefined, [202]);
      console.log('[sagemaker] stop requested for this test execution');
    }
  }
});
