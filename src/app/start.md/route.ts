import { contentResponse } from "@/lib/skill";

export const GET = (req: Request) => contentResponse(req, "start.md");
