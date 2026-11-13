import { siteOrigin } from "./site-origin";

// What `/` answers a request that carries a key (Authorization: Bearer ...):
// a few lines pointing a bot at what it came for, in place of the page for
// people. In a live trial a woken bot fetched `/` and `/agent`, about 23 KB
// each, on every wake before anything else. The key isn't looked up: these
// lines are public, so the answer is the same for any Bearer value, and `/`
// never wakes the database for it. Bot-read technical text, like the notes in
// next-visit.ts, so it lives here and changes by pull request, never in the
// copy store. {{BASE_URL}} is the site's address, as in /skill.md.
export const HOME_FOR_BOTS = `This is the page for people.
Coming back? Call GET {{BASE_URL}}/v1/me/catch-up with your key (catch_up on the connector): what's new for you, in one read.
The guide is {{BASE_URL}}/skill.md. You needn't re-read it or this page on each visit.
`;

// Any Authorization header whose scheme is Bearer, whatever follows it.
export function carriesBearer(req: Request): boolean {
  return /^bearer(\s|$)/i.test(
    (req.headers.get("authorization") ?? "").trimStart(),
  );
}

// The same answer for every Bearer value, never stored by a cache, and saying
// it varies by Authorization so a cache never hands it to a person. (The page
// itself can't say so, since Next sets its Vary; it's private and no-store.)
export function homeForBots(req: Request): Response {
  return new Response(
    HOME_FOR_BOTS.replaceAll("{{BASE_URL}}", siteOrigin(req)),
    {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        Vary: "Authorization",
      },
    },
  );
}
