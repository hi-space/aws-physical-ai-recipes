import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ResourceStrip } from './ResourceStrip';

const clients: QueryClient[] = [];
afterEach(() => {
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

function makeClient() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });
  client.setQueryData(['api', '/api/me'], {
    region: 'us-east-1',
    resources: {
      hyperPodEks: { clusterName: 'hp-eks', eksClusterName: 'hp-eks-cluster', logGroupPrefix: '/aws/eks/hp-eks' },
      dataBucket: 'data-bucket',
      artifactsBucket: 'artifacts-bucket',
    },
  });
  clients.push(client);
  return client;
}

function render(client: QueryClient) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(ResourceStrip, {
      items: [
        { label: 'HyperPod cluster', value: 'hp-eks', console: { kind: 'hyperpod-cluster', name: 'hp-eks' } },
        { label: 'Data bucket', value: 'data-bucket' },
        { label: 'Artifacts bucket', value: undefined },
      ],
      source: 'SageMaker DescribeCluster',
    })));
}

describe('ResourceStrip', () => {
  it('renders label and value pairs', () => {
    const html = render(makeClient());
    expect(html).toContain('HyperPod cluster');
    expect(html).toContain('hp-eks');
    expect(html).toContain('Data bucket');
    expect(html).toContain('data-bucket');
  });

  it('renders console link for items with console resource', () => {
    const html = render(makeClient());
    expect(html).toContain('https://us-east-1.console.aws.amazon.com/sagemaker/home?region=us-east-1#/cluster-management/hp-eks');
    expect(html).toContain('target="_blank"');
  });

  it('renders exactly one console link: items without a console resource get none', () => {
    const html = render(makeClient());
    expect(html.match(/target="_blank"/g)).toHaveLength(1);
    expect(html).not.toContain('s3/buckets/data-bucket');
  });

  it('hides items with undefined value', () => {
    const html = render(makeClient());
    expect(html).not.toContain('Artifacts bucket');
  });

  it('includes resource source text', () => {
    const html = render(makeClient());
    expect(html).toContain('SageMaker DescribeCluster');
    expect(html).toContain('출처'); // Korean: "source"
  });

  it('returns empty when no items to show and no source', () => {
    const client = makeClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client },
      createElement(ResourceStrip, {
        items: [{ label: 'Test', value: undefined }],
      })));
    expect(html).toBe('');
  });
});
