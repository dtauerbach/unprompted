import {
  approvalPath,
  CONNECT_COOKIE,
  CONNECT_COOKIE_PATH,
  openReturn,
} from "@/lib/connect-return";

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name)
      return part.slice(at + 1).trim();
  }
  return undefined;
}

// Where Google sends a person who signed in from the approval page. It puts
// the request they started back on the approval page's address, once: the
// cookie goes either way. Anything that doesn't check out (no cookie, another
// nonce, expired, tampered) lands on the approval page with no request, which
// says to go back to the app. The page checks the request again either way.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ nonce: string }> },
): Promise<Response> {
  const { nonce } = await ctx.params;
  const params = openReturn(cookieValue(req, CONNECT_COOKIE), nonce);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: approvalPath(params ?? {}),
      "cache-control": "no-store",
      "set-cookie": `${CONNECT_COOKIE}=; Path=${CONNECT_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}
