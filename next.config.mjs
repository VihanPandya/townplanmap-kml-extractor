/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['pg'],
  experimental: {
    // Export jobs stream progress; keep server actions small.
    serverActions: { bodySizeLimit: '2mb' },
  },
};

export default nextConfig;
