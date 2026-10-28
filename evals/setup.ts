import { beforeAll } from "vitest";
import { BASE_URL, get, LOCAL } from "./client";

// A production deploy names its canonical domain in /skill.md, whatever host
// it was reached by, while a preview names the host it was asked for. So a
// remote run whose /skill.md names another host is aimed at production, and
// stops before it writes anything.
beforeAll(async () => {
  if (LOCAL) return;
  const skill = await get("/skill.md");
  const named = /^Base URL: (\S+)$/m.exec(skill.text)?.[1];
  const want = new URL(BASE_URL).host;
  if (skill.status !== 200 || !named || new URL(named).host !== want)
    throw new Error(
      `${want} doesn't look like a preview: /skill.md answered ${skill.status} and names ${named ?? "no base URL"}. Refusing to write to it.`,
    );
});
