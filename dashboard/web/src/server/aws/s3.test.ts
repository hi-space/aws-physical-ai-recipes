import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client, type ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { HttpRequest } from '@smithy/protocol-http';
import { list } from './s3';

const boundary = vi.hoisted(() => ({ client: undefined as S3Client | undefined }));
vi.mock('./clients', () => ({ s3: () => boundary.client }));
vi.mock('../backends/context', () => ({ backendConfig: () => ({ eks: { dataBucket: 'fixture-bucket' } }) }));

describe('S3 listing continuation boundary', () => {
  let query: Record<string, unknown>;
  let inputToken: string | undefined;
  beforeEach(() => {
    boundary.client = new S3Client({
      region: 'us-east-1', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, maxAttempts: 1,
      requestHandler: {
        async handle(request: HttpRequest) {
          query = request.query;
          const invalid = request.query['continuation-token'] === '';
          return { response: {
            statusCode: invalid ? 400 : 200, headers: { 'content-type': 'application/xml' },
            body: Buffer.from(invalid
              ? '<Error><Code>InvalidArgument</Code><Message>The continuation token provided is incorrect</Message></Error>'
              : '<ListBucketResult><Name>fixture-bucket</Name><Prefix>data/</Prefix><IsTruncated>false</IsTruncated><Contents><Key>data/file.txt</Key><Size>3</Size></Contents></ListBucketResult>'),
          } };
        },
      },
    });
    boundary.client.middlewareStack.add(next => async args => {
      inputToken = (args.input as ListObjectsV2Command['input']).ContinuationToken;
      return next(args);
    }, { step: 'initialize', name: 'captureListingInput' });
  });
  afterEach(() => boundary.client?.destroy());

  it.each([undefined, ''])('omits an absent/empty token (%j) before SDK serialization', async token => {
    const listing = await list('fixture-bucket', 'data/', token);
    expect(inputToken).toBeUndefined();
    expect(query).not.toHaveProperty('continuation-token');
    expect(listing.entries).toEqual([{ key: 'data/file.txt', name: 'file.txt', size: 3, isPrefix: false }]);
  });

  it.each(['a+b/c==&next', ' a+b/c==&next '])('preserves opaque nonempty token %j at the SDK and HTTP boundary', async token => {
    await list('fixture-bucket', 'data/', token);
    expect(inputToken).toBe(token);
    expect(query['continuation-token']).toBe(token);
  });
});
