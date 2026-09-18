import { beforeEach, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('./clients', () => ({ sagemaker: () => ({ send }) }));
import { startExecution } from './sagemaker';
import { resetConfigForTests } from '../config';

beforeEach(() => {
  vi.stubEnv('ARTIFACTS_BUCKET', 'fixture'); vi.stubEnv('SM_PIPELINE_NAME', 'replacement');
  resetConfigForTests(); send.mockReset();
});
it('sends the pinned pipeline ARN to the SDK even if process configuration names another pipeline', async () => {
  const pipelineArn = 'arn:aws:sagemaker:us-east-1:123456789012:pipeline/original';
  send.mockResolvedValue({ PipelineExecutionArn: `${pipelineArn}/execution/one` });
  await startExecution({ MaxSteps: '0' }, 'pinned', 'stable-token', pipelineArn);
  expect(send.mock.calls[0][0].input).toMatchObject({
    PipelineName: pipelineArn, ClientRequestToken: 'stable-token', PipelineParameters: [{ Name: 'MaxSteps', Value: '0' }],
  });
});
