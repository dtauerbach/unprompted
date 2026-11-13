// Plays a signed-in person opening a trusted app's approval link in their
// browser: Google sign-in can't run in a script, so this goes through the
// same autoApprove the approval page calls, for a made-up sign-in id, with
// the headers a browser sends for a page it opens. Prints "approved <url>",
// or "page" with the refusal's code if one stopped it. Only against a local
// throwaway database.
//   npx tsx --conditions=react-server evals/auto-approve.ts <sign-in-id> <issuer> <query>
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [id, issuer, query] = process.argv.slice(2);
if (!isThrowaway(url) || !url || !id || !issuer || query === undefined) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/auto-approve.ts <sign-in-id> <issuer> <query>",
  );
  process.exit(1);
}
// The site's own db() reads DATABASE_URL: point it at the throwaway one
// before anything loads it.
process.env.DATABASE_URL = url;
const { autoApprove } = await import("../src/lib/connector");
const { closeDb } = await import("../src/lib/db");
const { hashIp } = await import("../src/lib/http");
try {
  const params = Object.fromEntries(new URLSearchParams(query));
  // The app's own page sends the person here, so the browser names its
  // origin; a callback that doesn't parse gets no Referer, and the page.
  let referer = "";
  try {
    referer = `${new URL(params.redirect_uri ?? "").origin}/`;
  } catch {}
  const r = await autoApprove(
    params,
    {
      method: "GET",
      repeated: false,
      headers: new Headers({
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
        ...(referer ? { referer } : {}),
      }),
      authUserId: id,
      ipHash: hashIp(`10.250.${Math.floor(Math.random() * 250)}.1`),
    },
    issuer,
  );
  console.log(
    r.kind === "approved"
      ? `approved ${r.url}`
      : `page ${r.refusal?.code ?? ""}`,
  );
} finally {
  await closeDb();
}
