import { describe, expect, it } from "vitest";
import { authBaseUrl, formActionSources } from "@/lib/neon-auth-hosts";
import nextConfig from "../../next.config";

// The sign-in form may post only where a deploy actually signs people in:
// the security policy and human-auth.ts read one list, so they can't drift.
describe("where the sign-in form may post", () => {
  const prod = { VERCEL_ENV: "production" };
  const preview = { VERCEL_ENV: "preview" };

  it("names each deploy's own auth server and no other", () => {
    const p = formActionSources(prod);
    const v = formActionSources(preview);
    const prodOrigin = new URL(authBaseUrl(prod) as string).origin;
    const previewOrigin = new URL(authBaseUrl(preview) as string).origin;
    expect(prodOrigin).not.toBe(previewOrigin);
    expect(p).toEqual(["'self'", "https://accounts.google.com", prodOrigin]);
    expect(v).toEqual(["'self'", "https://accounts.google.com", previewOrigin]);
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
