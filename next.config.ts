import type { NextConfig } from "next";
import { formActionSources } from "./src/lib/neon-auth-hosts";

// form-action allows the site's own forms: the sign-in and account pages post
// back to themselves as server actions. Without JavaScript, signing in posts
// and is redirected on, through this deploy's auth server, to Google, which
// Chrome checks against form-action too. Read at build time, from the same
// list human-auth.ts signs in with (src/lib/neon-auth-hosts.ts).
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Content-Security-Policy",
    value: `frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action ${formActionSources().join(" ")}`,
  },
];

// The approval page sends the person back to their app, which can be any
// https address or one on their own machine. Without JavaScript that's a
// redirect after a form post, which form-action governs.
const approvalHeaders = [
  {
    key: "Content-Security-Policy",
    value:
      "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self' https: http://localhost:* http://127.0.0.1:*",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // content/ is read from disk at request time, so it must ship with the server bundle.
  outputFileTracingIncludes: {
    "/skill.md": ["./content/skill.md"],
    "/agent": ["./content/skill.md"],
    "/llms.txt": ["./content/skill.md"],
    "/welcome.md": ["./content/welcome.md"],
    "/v1/mcp": ["./content/mcp.md"],
  },
  // The About page became the home page; old links still land on it.
  async redirects() {
    return [{ source: "/about", destination: "/", permanent: true }];
  },
  // The connector's addresses, where OAuth and MCP clients look for them.
  // Every route behind them lives under /v1.
  async rewrites() {
    return [
      { source: "/mcp", destination: "/v1/mcp" },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/v1/oauth/metadata",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/v1/oauth/resource",
      },
      {
        source: "/.well-known/oauth-protected-resource/mcp",
        destination: "/v1/oauth/resource",
      },
    ];
  },
  async headers() {
    // A later match overrides an earlier one's header of the same name.
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/oauth/authorize", headers: approvalHeaders },
    ];
  },
};

export default nextConfig;
