import { afterEach, describe, expect, it } from "vitest";
import {
  authBaseUrl,
  cookieSecret,
  humanSignInEnabled,
} from "@/lib/human-auth";

const saved = { ...process.env };
afterEach(() => {
  for (const k of [
    "VERCEL_ENV",
    "NEON_AUTH_BASE_URL",
    "NEON_AUTH_COOKIE_SECRET",
    "IP_HASH_SECRET",
  ]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("human sign-in settings", () => {
  it("use production's auth server there, and a preview only the one it's given", () => {
    delete process.env.NEON_AUTH_BASE_URL;
    process.env.VERCEL_ENV = "production";
    const prod = authBaseUrl();
    expect(prod).toMatch(
      /^https:\/\/[a-z0-9-]+\.neonauth\.[^/]+\/neondb\/auth$/,
    );
    // A preview's Neon branch has its own auth server, whose address Neon's
    // Vercel integration hands it. Without one it never falls back to
    // production's, or to anyone else's: sign-in is just off.
    process.env.VERCEL_ENV = "preview";
    process.env.IP_HASH_SECRET = "x".repeat(40);
    expect(authBaseUrl()).toBeUndefined();
    expect(humanSignInEnabled()).toBe(false);
    const branch =
      "https://ep-calm-tree-a1b2c3d4.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth";
    process.env.NEON_AUTH_BASE_URL = branch;
    expect(authBaseUrl()).toBe(branch);
    expect(authBaseUrl()).not.toBe(prod);
    expect(humanSignInEnabled()).toBe(true);
  });

  it("are off anywhere else unless an address is given", () => {
    delete process.env.NEON_AUTH_BASE_URL;
    process.env.IP_HASH_SECRET = "x".repeat(40);
    delete process.env.VERCEL_ENV;
    expect(authBaseUrl()).toBeUndefined();
    expect(humanSignInEnabled()).toBe(false);
    process.env.VERCEL_ENV = "development";
    expect(humanSignInEnabled()).toBe(false);
    process.env.NEON_AUTH_BASE_URL = "https://auth.example/neondb/auth";
    expect(authBaseUrl()).toBe("https://auth.example/neondb/auth");
    expect(humanSignInEnabled()).toBe(true);
  });

  it("are off without a secret to sign cookies with", () => {
    process.env.NEON_AUTH_BASE_URL = "https://auth.example/neondb/auth";
    delete process.env.IP_HASH_SECRET;
    delete process.env.NEON_AUTH_COOKIE_SECRET;
    expect(cookieSecret()).toBeUndefined();
    expect(humanSignInEnabled()).toBe(false);
  });

  it("derive the cookie secret, long enough and never the root secret", () => {
    delete process.env.NEON_AUTH_COOKIE_SECRET;
    process.env.IP_HASH_SECRET = "root-secret-for-tests";
    const a = cookieSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("root-secret-for-tests");
    expect(cookieSecret()).toBe(a);
    process.env.IP_HASH_SECRET = "another-root";
    expect(cookieSecret()).not.toBe(a);
    process.env.NEON_AUTH_COOKIE_SECRET = "y".repeat(32);
    expect(cookieSecret()).toBe("y".repeat(32));
  });
});
