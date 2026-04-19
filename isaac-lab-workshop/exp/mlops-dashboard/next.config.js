const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@rerun-io/web-viewer-react', '@rerun-io/web-viewer'],
  webpack: (config) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    config.resolve.alias = {
      ...config.resolve.alias,
      '@rerun-io/web-viewer-react': path.resolve(__dirname, 'node_modules/@rerun-io/web-viewer-react/index.js'),
      '@rerun-io/web-viewer': path.resolve(__dirname, 'node_modules/@rerun-io/web-viewer/index.js'),
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },
}

module.exports = nextConfig
