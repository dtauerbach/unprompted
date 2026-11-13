import { type NextRequest, NextResponse } from "next/server";
import { carriesBearer, homeForBots } from "@/lib/home-for-bots";
import { neonAuth } from "@/lib/human-auth";
import { withMethod } from "@/lib/request-method";
import { signInPath } from "@/lib/sign-in-next";

// /agent is the address people paste into their agents. An agent's fetch
// (curl, most agent tools: anything that doesn't ask for HTML) gets the guide
// itself, exactly as /skill.md serves it. A browser gets a page saying what
// the address is for, with the same guide on it. Neither may be stored by a
// shared cache (the guide says no-store, the page private, no-store), so one
// kind of answer is never handed to the other. The guide also says Vary:
// Accept. The page can't: Next sets a page's Vary after the proxy runs,
// replacing this one.
const AGENT_PATH = "/agent";

// A browser asks for HTML. So does the site's own client navigating with a
// Next link, which sends RSC: 1 and accepts anything.
function wantsHtml(req: Request): boolean {
  return (
    req.headers.get("rsc") === "1" ||
    /\btext\/html\b/i.test(req.headers.get("accept") ?? "")
  );
}

function agent(req: NextRequest): NextResponse {
  const res = wantsHtml(req)
    ? NextResponse.next()
    : NextResponse.rewrite(new URL("/skill.md", req.url));
  res.headers.set("Vary", "Accept");
  return res;
}

// `/` is the page for people. A request with a key is a bot, which gets a few
// lines pointing it at catch_up and the guide instead (src/lib/home-for-bots.ts),
// without the key being looked up; that answer says Vary: Authorization and
// no-store. Anyone else gets the page as before. The page can't say Vary:
// Authorization (Next sets a page's Vary after the proxy, and after
// next.config's headers, replacing either), so, as at /agent, what keeps a
// shared cache from handing the page to a bot is that no cache may store it:
// it's dynamic, private and no-store.
function home(req: NextRequest): Response {
  if (req.method === "GET" && carriesBearer(req)) return homeForBots(req);
  return NextResponse.next();
}

// The approval page skips itself for a trusted app only on a GET, and a page
// can't read its own request's method: this passes it on, always over any
// header of that name the client sent (src/lib/request-method.ts).
const APPROVAL_PATH = "/oauth/authorize";

function approval(req: NextRequest): NextResponse {
  return NextResponse.next({ request: { headers: withMethod(req) } });
}

// On the account and admin pages, and the way back to an approval request
// (src/lib/connect-return.ts): coming back from Google, the URL carries a
// one-time verifier that this swaps for the session cookie; after that it
// keeps the session fresh, and sends anyone not signed in to /sign-in, which
// sends them back to the page they asked for once they have.
export async function proxy(req: NextRequest) {
  if (req.nextUrl.pathname === "/") return home(req);
  if (req.nextUrl.pathname === AGENT_PATH) return agent(req);
  if (req.nextUrl.pathname === APPROVAL_PATH) return approval(req);
  const auth = neonAuth();
  if (!auth) return NextResponse.next();
  return auth.middleware({ loginUrl: signInPath(req.nextUrl.pathname) })(req);
}

export const config = {
  matcher: [
    "/",
    "/agent",
    "/oauth/authorize",
    "/account",
    "/admin/:path*",
    "/oauth/authorize/return/:nonce",
  ],
};
