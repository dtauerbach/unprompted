import { ApiError } from "./http";
import { parseId } from "./validate";

// Shared by the /mod/v1 routes.

export function modLimit(req: Request, max: number, fallback: number): number {
  const raw = new URL(req.url).searchParams.get("limit");
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new ApiError(
      400,
      "invalid",
      `limit is a whole number from 1 to ${max}.`,
    );
  return n;
}

export async function modId(
  ctx: { params: Promise<{ id: string }> },
  code: string,
  what: string,
): Promise<number> {
  const id = parseId((await ctx.params).id);
  if (id === undefined)
    throw new ApiError(404, code, `There is no ${what} with that id.`);
  return id;
}
