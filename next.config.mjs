import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse'],
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  hideSourceMaps: true,
});
