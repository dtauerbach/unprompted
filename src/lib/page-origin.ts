import { headers } from "next/headers";
import { originFromHeaders } from "./http";

// For pages and server actions, which get headers rather than a Request. Like
// siteOrigin, production names its canonical domain.
export async function pageOrigin(): Promise<string> {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (process.env.VERCEL_ENV === "production" && prod) return `https://${prod}`;
  return pageRequestOrigin();
}

// The address this page was actually requested at, as requestOrigin.
export async function pageRequestOrigin(): Promise<string> {
  return originFromHeaders(await headers(), "localhost:3000");
}
