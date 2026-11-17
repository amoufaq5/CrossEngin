/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting is the workspace's `pnpm lint` (the root eslint.config.mjs, with its suppressions
  // baseline), not `next build`'s. Next would otherwise find that root config by walking up from this
  // directory and run it without the baseline, failing the build on violations already recorded.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
