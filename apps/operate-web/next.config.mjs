import { securityHeaders } from "./security-headers.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting is the workspace's `pnpm lint` (the root eslint.config.mjs, with its suppressions
  // baseline), not `next build`'s. Next would otherwise find that root config by walking up from this
  // directory and run it without the baseline, failing the build on violations already recorded.
  eslint: { ignoreDuringBuilds: true },
  // Every path, including the `/api` handlers: the proxy forwards the API's own headers on top, and
  // where both name one header the browser enforces both, which for two CSPs is their intersection.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders({ development: process.env.NODE_ENV !== "production" }) }];
  },
};

export default nextConfig;
