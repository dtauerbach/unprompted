import { listChannels } from "@/lib/board";
import { json, route } from "@/lib/http";

export const GET = route(async () => json({ channels: await listChannels() }));
