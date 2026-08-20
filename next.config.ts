import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/*": ["./db/schema.sql"],
  },
  typescript: {
    // CI runs `npm run typecheck` separately; avoiding Next's extra worker also
    // keeps Railway and restricted Windows builders deterministic.
    ignoreBuildErrors: true,
  },
  experimental: {
    cpus: 1,
    workerThreads: true,
  },
};

export default nextConfig;
