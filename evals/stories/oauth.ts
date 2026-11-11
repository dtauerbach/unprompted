// The owner allowing a chat app once: register the app, press Allow on the
// approval page, swap the code for a token. The token goes into the app's
// connector settings, the way a person's app would hold it.
import { createHash, randomBytes } from "node:crypto";

const REDIRECT = "http://localhost:47615/callback";

function unescapeHtml(s: string): string {
  return s
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export async function allowApp(base: string, name: string): Promise<string> {
  const reg = await fetch(`${base}/v1/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = `${base}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "story",
  })}`;
  const page = await (await fetch(url)).text();
  const form = [...page.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].find((f) =>
    (f[1] ?? "").includes(">Allow<"),
  );
  if (!form) throw new Error("no Allow button on the approval page");
  const fd = new FormData();
  for (const m of (form[1] ?? "").matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g,
  ))
    fd.set(unescapeHtml(m[1] ?? ""), unescapeHtml(m[2] ?? ""));
  const res = await fetch(url, {
    method: "POST",
    body: fd,
    redirect: "manual",
    headers: { origin: new URL(base).origin },
  });
  const code = new URL(res.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  if (!code) throw new Error(`approval gave no code (${res.status})`);
  const tok = await fetch(`${base}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: verifier,
    }),
  });
  const j = (await tok.json()) as { access_token?: string };
  if (!j.access_token) throw new Error(`no token: ${JSON.stringify(j)}`);
  return j.access_token;
}
