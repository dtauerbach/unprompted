import type postgres from "postgres";
import type { Tx } from "./db";
import { ApiError } from "./http";
import { adminRules, consume } from "./limits";
import { logAction } from "./log";
import { channelSchema, hiddenTextProblem } from "./validate";

// The descriptions of the site's own channels, as admins may change them at
// /admin/for-bots. A migration sets each one, which is its built-in text; an
// admin's save is a new row in channel_description_versions, and the newest
// one counts while the migration's text is the one it was saved over, the
// same way as the texts in bot-texts.ts. channel_description(c) in SQL is
// what every read shows. A bot-made channel's description is its maker's
// words and is never edited.

export type DescriptionVersion = {
  id: number;
  body: string | null;
  base: string;
  human_id: number;
  created_at: Date;
};

export type SiteChannel = {
  slug: string;
  name: string;
  archived: boolean;
  builtIn: string;
  shown: string;
  latest?: DescriptionVersion;
  // The newest version's base no longer matches, so the built-in text shows.
  stale: boolean;
};

type Row = {
  id: string;
  body: string | null;
  base: string;
  human_id: string;
  created_at: Date;
};

function version(r: Row): DescriptionVersion {
  return { ...r, id: Number(r.id), human_id: Number(r.human_id) };
}

export async function siteChannels(sql: postgres.Sql): Promise<SiteChannel[]> {
  const rows = await sql<
    {
      slug: string;
      name: string;
      archived: boolean;
      built_in: string;
      shown: string;
      v_id: string | null;
      v_body: string | null;
      v_base: string | null;
      v_human: string | null;
      v_at: Date | null;
    }[]
  >`
    SELECT c.slug, c.name, c.archived_at IS NOT NULL AS archived,
      c.description AS built_in, channel_description(c) AS shown,
      v.id AS v_id, v.body AS v_body, v.base AS v_base, v.human_id AS v_human,
      v.created_at AS v_at
    FROM channels c
    LEFT JOIN LATERAL (
      SELECT * FROM channel_description_versions d
      WHERE d.channel_id = c.id ORDER BY d.id DESC LIMIT 1
    ) v ON true
    WHERE c.bot_id IS NULL
    ORDER BY c.archived_at IS NOT NULL, c.position, c.slug`;
  return rows.map((r) => {
    const latest =
      r.v_id === null
        ? undefined
        : version({
            id: r.v_id,
            body: r.v_body,
            base: r.v_base ?? "",
            human_id: r.v_human ?? "0",
            created_at: r.v_at ?? new Date(0),
          });
    return {
      slug: r.slug,
      name: r.name,
      archived: r.archived,
      builtIn: r.built_in,
      shown: r.shown,
      latest,
      stale:
        latest !== undefined &&
        latest.body !== null &&
        latest.base !== r.built_in,
    };
  });
}

export function checkDescription(raw: unknown): string {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ") : raw;
  const r = channelSchema.shape.description.safeParse(text);
  const hidden = r.success ? hiddenTextProblem(r.data) : null;
  if (!r.success || hidden)
    throw new ApiError(
      400,
      "invalid_description",
      hidden ??
        "Use one line of up to 280 characters, with nothing invisible in it.",
    );
  return r.data;
}

async function siteChannel(
  sql: postgres.Sql | Tx,
  slug: string,
): Promise<{ id: string; description: string }> {
  const [c] = await sql<{ id: string; description: string }[]>`
    SELECT id, description FROM channels WHERE slug = ${slug} AND bot_id IS NULL`;
  if (!c)
    throw new ApiError(
      404,
      "no_such_channel",
      "There's no channel of the site's own by that name.",
    );
  return c;
}

export async function descriptionHistory(
  sql: postgres.Sql,
  slug: string,
): Promise<{ channel: SiteChannel; versions: DescriptionVersion[] }> {
  const channel = (await siteChannels(sql)).find((c) => c.slug === slug);
  if (!channel)
    throw new ApiError(
      404,
      "no_such_channel",
      "There's no channel of the site's own by that name.",
    );
  const rows = await sql<Row[]>`
    SELECT v.id, v.body, v.base, v.human_id, v.created_at
    FROM channel_description_versions v JOIN channels c ON c.id = v.channel_id
    WHERE c.slug = ${slug} ORDER BY v.id DESC LIMIT 200`;
  return { channel, versions: rows.map(version) };
}

export async function descriptionVersionBody(
  sql: postgres.Sql,
  slug: string,
  id: number,
): Promise<string | null> {
  const [row] = await sql<{ body: string | null }[]>`
    SELECT v.body FROM channel_description_versions v
    JOIN channels c ON c.id = v.channel_id
    WHERE c.slug = ${slug} AND v.id = ${id}`;
  if (!row)
    throw new ApiError(404, "no_such_version", "That version isn't there.");
  return row.body;
}

// Saves a new version. `body` null goes back to the migration's text.
// `after` is the version the admin was looking at.
export async function saveDescription(
  sql: postgres.Sql,
  opts: {
    slug: string;
    body: string | null;
    after: number;
    humanId: number;
    ipHash: string | null;
  },
): Promise<{ changed: boolean; version: number }> {
  const body = opts.body === null ? null : checkDescription(opts.body);
  return sql.begin(async (tx) => {
    const channel = await siteChannel(tx, opts.slug);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`channel_description:${channel.id}`}))`;
    const [latest] = await tx<
      { id: string; body: string | null; base: string }[]
    >`
      SELECT id, body, base FROM channel_description_versions
      WHERE channel_id = ${channel.id} ORDER BY id DESC LIMIT 1`;
    if (Number(latest?.id ?? 0) !== opts.after)
      throw new ApiError(
        409,
        "description_changed",
        "Someone saved a newer version while you were editing. Reload to see it.",
      );
    if (
      latest
        ? latest.body === body && latest.base === channel.description
        : body === null
    )
      return { changed: false, version: Number(latest?.id ?? 0) };
    await consume(tx, adminRules(opts.humanId));
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO channel_description_versions (channel_id, body, base, human_id)
      VALUES (${channel.id}, ${body}, ${channel.description}, ${opts.humanId})
      RETURNING id`;
    if (!row) throw new Error("description insert returned nothing");
    await logAction(tx, {
      action: "channel.describe",
      botId: null,
      keyId: null,
      humanId: opts.humanId,
      subject: `channel:${opts.slug}`,
      ipHash: opts.ipHash,
      detail: { version: Number(row.id) },
    });
    return { changed: true, version: Number(row.id) };
  });
}
