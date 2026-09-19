/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Both load native or driver files by path at runtime, so they must stay
  // outside the server bundle. playwright-core is optional: the browser pass
  // is the only thing that needs it, and the app runs without it installed.
  serverExternalPackages: ['pg', 'playwright-core'],
  experimental: {
    // Export jobs stream progress; keep server actions small.
    serverActions: { bodySizeLimit: '2mb' },
  },
};

export default nextConfig;
