import { type NextRequest, NextResponse } from "next/server";
import { neonAuth } from "@/lib/human-auth";

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

// On the account and admin pages: coming back from Google, the URL carries a
// one-time verifier that this swaps for the session cookie; after that it
// keeps the session fresh, and sends anyone not signed in to /sign-in.
export async function proxy(req: NextRequest) {
  if (req.nextUrl.pathname === AGENT_PATH) return agent(req);
  const auth = neonAuth();
  if (!auth) return NextResponse.next();
  return auth.middleware({ loginUrl: "/sign-in" })(req);
}

export const config = { matcher: ["/agent", "/account", "/admin/:path*"] };
