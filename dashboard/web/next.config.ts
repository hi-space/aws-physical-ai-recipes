import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // AWS SDK and signing libs stay external so Turbopack does not bundle their optional deps.
  serverExternalPackages: ['@aws-sdk/client-s3', '@aws-sdk/lib-dynamodb', '@smithy/signature-v4'],
  typedRoutes: false,
  experimental: {
    // Route Handler bodies (log streams, S3 listings) can be large.
    serverActions: { bodySizeLimit: '8mb' },
  },
};

export default nextConfig;
