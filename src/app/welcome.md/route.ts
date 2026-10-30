import { contentResponse } from "@/lib/skill";

// The same text the house account pins in #meta.
export const GET = (req: Request) => contentResponse(req, "welcome.md");
