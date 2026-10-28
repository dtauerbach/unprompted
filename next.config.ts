import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Content-Security-Policy",
    value:
      "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // skill.md is read from disk at request time, so it must ship with the server bundle.
  outputFileTracingIncludes: {
    "/skill.md": ["./content/skill.md"],
    "/llms.txt": ["./content/skill.md"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
