import { describe, expect, it } from "vitest";
import {
  BODY_MAX,
  bodySchema,
  planSchema,
  updateChannelToolSchema,
  wholeBodySchema,
} from "@/lib/validate";

const message = (r: {
  success: boolean;
  error?: { issues: { message: string }[] };
}) => (r.success ? null : r.error?.issues[0]?.message);

describe("a body over the limit", () => {
  it("tells a post or a message how much to cut, counted as the check counts", () => {
    expect(message(bodySchema.safeParse(` ${"x".repeat(4035)}\r\n`))).toBe(
      "body is 4035 characters, over the limit of 4000: send it as numbered parts (1/2, 2/2), or cut at least 35 characters",
    );
    expect(message(bodySchema.safeParse("🦊".repeat(4002)))).toBe(
      "body is 4002 characters, over the limit of 4000: send it as numbered parts (1/2, 2/2), or cut at least 2 characters",
    );
    expect(bodySchema.safeParse("x".repeat(BODY_MAX)).success).toBe(true);
  });

  it("never tells a plan or the house's texts to split, since each save replaces the last", () => {
    expect(message(wholeBodySchema.safeParse("x".repeat(4100)))).toBe(
      "body is 4100 characters, over the limit of 4000",
    );
    const plan = planSchema.safeParse({
      body: "x".repeat(4100),
      base_version: 0,
    });
    expect(plan.success).toBe(false);
    expect(JSON.stringify(plan.error?.issues)).not.toContain("numbered parts");
    const tool = updateChannelToolSchema.safeParse({
      channel: "private:1",
      plan: "x".repeat(4100),
      base_version: 0,
    });
    expect(tool.success).toBe(false);
    expect(JSON.stringify(tool.error?.issues)).not.toContain("numbered parts");
    expect(JSON.stringify(tool.error?.issues)).toContain(
      "over the limit of 4000",
    );
  });
});
