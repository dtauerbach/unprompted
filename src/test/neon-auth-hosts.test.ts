import { describe, expect, it } from "vitest";
import {
  authBaseUrl,
  endpointOf,
  formActionSources,
  productionEndpoint,
} from "@/lib/neon-auth-hosts";
import nextConfig from "../../next.config";

// The sign-in form may post only where a deploy actually signs people in:
// the security policy and human-auth.ts read one list, so they can't drift.
describe("where the sign-in form may post", () => {
  const prod = { VERCEL_ENV: "production" };
  const preview = { VERCEL_ENV: "preview" };

  it("names production's own auth server, and a preview's only when given", () => {
    const p = formActionSources(prod);
    const prodOrigin = new URL(authBaseUrl(prod) as string).origin;
    expect(p).toEqual(["'self'", "https://accounts.google.com", prodOrigin]);
    // A preview has no built-in auth server: its Neon branch's comes from
    // Neon's Vercel integration, as NEON_AUTH_BASE_URL.
    expect(authBaseUrl(preview)).toBeUndefined();
    expect(formActionSources(preview)).toEqual([
      "'self'",
      "https://accounts.google.com",
    ]);
    const branch = {
      VERCEL_ENV: "preview",
      NEON_AUTH_BASE_URL:
        "https://ep-calm-tree-a1b2c3d4.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth",
    };
    const v = formActionSources(branch);
    expect(v).toEqual([
      "'self'",
      "https://accounts.google.com",
      "https://ep-calm-tree-a1b2c3d4.neonauth.c-6.us-east-2.aws.neon.tech",
    ]);
    expect(v).not.toContain(prodOrigin);
  });

  it("reads production's endpoint from its auth server, and any host's endpoint", () => {
    expect(productionEndpoint()).toMatch(/^ep-[a-z0-9-]+$/);
    expect(new URL(authBaseUrl(prod) as string).hostname).toMatch(
      new RegExp(`^${productionEndpoint()}\\.`),
    );
    expect(
      endpointOf("ep-sweet-haze-b4klf00x-pooler.c-6.us-east-2.aws.neon.tech"),
    ).toBe("ep-sweet-haze-b4klf00x");
    expect(
      endpointOf("EP-Sweet-Haze-B4KLF00X.c-6.us-east-2.aws.neon.tech"),
    ).toBe("ep-sweet-haze-b4klf00x");
    expect(endpointOf("localhost")).toBe("localhost");
  });

  it("names no auth server where sign-in is off", () => {
    expect(formActionSources({})).toEqual([
      "'self'",
      "https://accounts.google.com",
    ]);
    expect(formActionSources({ VERCEL_ENV: "development" })).toHaveLength(2);
  });

  it("follows an override, by origin only, and never a wildcard", () => {
    const env = {
      VERCEL_ENV: "production",
      NEON_AUTH_BASE_URL: "https://auth.example/neondb/auth?x=1",
    };
    expect(authBaseUrl(env)).toBe("https://auth.example/neondb/auth?x=1");
    expect(formActionSources(env)).toEqual([
      "'self'",
      "https://accounts.google.com",
      "https://auth.example",
    ]);
    for (const e of [prod, preview, env, {}])
      for (const s of formActionSources(e)) expect(s).not.toContain("*");
  });

  it("refuses a plain-http auth server unless it's on this machine", () => {
    expect(() =>
      formActionSources({ NEON_AUTH_BASE_URL: "http://auth.example/x" }),
    ).toThrow(/https/);
    expect(
      formActionSources({ NEON_AUTH_BASE_URL: "http://localhost:4000/x" }),
    ).toContain("http://localhost:4000");
    expect(() =>
      formActionSources({ NEON_AUTH_BASE_URL: "ep-x.neonauth.example/auth" }),
    ).toThrow(/NEON_AUTH_BASE_URL/);
    expect(
      formActionSources({ NEON_AUTH_BASE_URL: "https://auth.example:8443/a" }),
    ).toContain("https://auth.example:8443");
  });

  it("is what the site's security headers send", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((r) => r.source === "/:path*");
    const csp = all?.headers.find(
      (h) => h.key === "Content-Security-Policy",
    )?.value;
    expect(csp).toContain(`form-action ${formActionSources().join(" ")}`);
    expect(csp).not.toContain("*.neonauth");
  });
});
