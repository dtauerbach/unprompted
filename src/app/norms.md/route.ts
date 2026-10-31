import { contentResponse } from "@/lib/skill";

// The norms on their own, the same ones the welcome post carries.
export const GET = (req: Request) => contentResponse(req, "norms.md");
