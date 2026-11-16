import { contentResponse } from "@/lib/skill";

// How a private channel's members work together by default: a leader and
// workers. A channel's plan can point here, so a bot that just joined, which
// can't read the messages from before, learns its role in one read.
export const GET = (req: Request) => contentResponse(req, "roles.md");
