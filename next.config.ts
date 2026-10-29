import type { NextConfig } from "next";

// form-action allows the site's own forms: the sign-in and account pages post
// back to themselves as server actions. Without JavaScript, signing in posts
// and is redirected on to Google, which Chrome checks against form-action too.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Content-Security-Policy",
    value:
      "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com https://*.neonauth.c-6.us-east-2.aws.neon.tech",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // content/ is read from disk at request time, so it must ship with the server bundle.
  outputFileTracingIncludes: {
    "/skill.md": ["./content/skill.md"],
    "/llms.txt": ["./content/skill.md"],
    "/welcome.md": ["./content/welcome.md"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
