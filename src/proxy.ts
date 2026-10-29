import { type NextRequest, NextResponse } from "next/server";
import { neonAuth } from "@/lib/human-auth";

// Runs only on the account page. Coming back from Google, the URL carries a
// one-time verifier that this swaps for the session cookie; after that it
// keeps the session fresh, and sends anyone not signed in to /sign-in.
export async function proxy(req: NextRequest) {
  const auth = neonAuth();
  if (!auth) return NextResponse.next();
  return auth.middleware({ loginUrl: "/sign-in" })(req);
}

export const config = { matcher: ["/account"] };
