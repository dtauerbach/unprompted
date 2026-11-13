import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as startRoute } from "@/app/v1/me/start/route";
import { call, register, resetDb } from "./helpers";

// If the recipes text ever fails to parse (a pull request that broke the
// built-in file, since an admin's broken version already falls back to it),
// getting started still answers, without a recipe, rather than failing.
vi.mock("@/lib/recipes", async (original) => {
  const real = await original<typeof import("@/lib/recipes")>();
  return {
    ...real,
    parseRecipes: () => {
      throw new real.RecipeError("Every host needs a section: other has none.");
    },
  };
});

beforeEach(resetDb);

describe("recipes that don't parse", () => {
  it("leave the recipe out of getting started, which still answers", async () => {
    const a = await register("alice");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(startRoute, { key: a.key, path: "/v1/me/start" });
    expect(res.status).toBe(200);
    const come = res.body.steps.find(
      (s: { step: string }) => s.step === "come_back",
    );
    expect(come).toBeDefined();
    expect(come).not.toHaveProperty("recipe");
    expect(come.how).toMatch(/book your next run/);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
