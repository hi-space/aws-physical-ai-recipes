import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ send: vi.fn(), fetch: vi.fn() }));
vi.mock('@/server/config', () => ({ config: () => ({
  region: 'us-east-1', groot: { mlflowTrackingServerArn: 'arn:aws:sagemaker:us-east-1:123456789012:mlflow-tracking-server/test' },
}) }));
vi.mock('@/server/aws/clients', () => ({ sagemaker: () => ({ send: fake.send }) }));
vi.mock('@/server/aws/sigv4', () => ({ sigv4Fetch: fake.fetch }));
import { getExperiment, searchExperiments, searchRuns } from '@/server/aws/mlflow';
beforeEach(() => {
  fake.send.mockReset().mockResolvedValue({ TrackingServerUrl: 'https://tracking.example.invalid' });
  fake.fetch.mockReset().mockImplementation(async () => Response.json({}));
});
describe('managed MLflow query helpers (fake transport)', () => {
  it('sends the experiment prefix filter without changing default legacy callers', async () => {
    await searchExperiments("name LIKE 'pai/a/%'");
    expect(JSON.parse(fake.fetch.mock.calls[0][0].body)).toMatchObject({ filter: "name LIKE 'pai/a/%'", max_results: 200 });
    await searchExperiments();
    expect(JSON.parse(fake.fetch.mock.calls[1][0].body)).not.toHaveProperty('filter');
  });
  it('looks up an experiment by concrete ID and preserves server-supplied run constraints', async () => {
    fake.fetch.mockImplementation(async request => Response.json(
      request.url.includes('experiments/get') ? { experiment: { experiment_id: '17', name: 'pai/a/run' } } : { runs: [] },
    ));
    expect(await getExperiment('17')).toMatchObject({ experiment_id: '17', name: 'pai/a/run' });
    expect(new URL(fake.fetch.mock.calls[0][0].url).searchParams.get('experiment_id')).toBe('17');
    await searchRuns(['17'], "tags.`pai.project_id` = 'a'", 25);
    expect(JSON.parse(fake.fetch.mock.calls[1][0].body)).toMatchObject({
      experiment_ids: ['17'], filter: "tags.`pai.project_id` = 'a'", max_results: 25,
    });
  });
});
