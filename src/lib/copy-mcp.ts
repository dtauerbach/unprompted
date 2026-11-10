import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  COPY,
  COPY_PAGES,
  type CopyKey,
  copyHistory,
  fitsPiece,
  isCopyKey,
  latestVersions,
  MAX_COPY,
  mayEdit,
  saveCopy,
  slotsOf,
  versionBody,
} from "./copy";
import type { CopyKeyEditor } from "./copy-editors";
import { db } from "./db";
import { ApiError, logRefusal } from "./http";
import { assertWritable } from "./settings";

// The copy connector: the words on people's pages, for an app holding a copy
// key (src/lib/copy-editors.ts). It does what a copy editor does at
// /admin/copy, through the same functions and checks, and nothing else.

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const INSTRUCTIONS =
  "The words on Unprompted's pages for people. Every save is a new version, kept, and can be undone. Change only what you were asked to change, word for word. Keep every {spot}: the page fills it in. Plain text only.";

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
} as const;

async function run(
  tool: string,
  write: boolean,
  fn: () => Promise<unknown>,
): Promise<Result> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn()) }] };
  } catch (err) {
    let e = err;
    if (!(e instanceof ApiError)) {
      console.error(err);
      e = new ApiError(500, "internal", "Something went wrong on our side.");
    }
    const a = e as ApiError;
    if (write) logRefusal("MCP", `/copy/mcp ${tool}`, a);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: { code: a.code, message: a.message } }),
        },
      ],
      isError: true,
    };
  }
}

const keySchema = z
  .string()
  .max(80)
  .refine(isCopyKey, "There's no such piece. list_copy names them all.");

function piece(key: string): CopyKey {
  if (!isCopyKey(key))
    throw new ApiError(404, "no_such_copy", "There's no such piece of copy.");
  return key;
}

export function buildCopyMcpServer(opts: {
  editor: CopyKeyEditor;
  ipHash: string;
  // Called after a save, so the pages show the new words.
  saved: () => void;
}): McpServer {
  const { editor, ipHash } = opts;
  const server = new McpServer(
    { name: "unprompted-copy", title: "Unprompted copy", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_copy",
    {
      title: "List the words on the site",
      description:
        "Every piece of copy, by page: its key, what it is, the words showing now, the version they're from (0: the original), its {spots}, and whether you may change it.",
      inputSchema: z.strictObject({
        page: z
          .enum(COPY_PAGES.map((p) => p.page) as [string, ...string[]])
          .optional(),
      }),
      annotations: READ,
    },
    ({ page }) =>
      run("list_copy", false, async () => {
        const latest = await latestVersions(db());
        return {
          pages: COPY_PAGES.filter((p) => !page || p.page === page).map(
            (p) => ({
              page: p.page,
              title: p.title,
              path: p.path,
              pieces: (Object.keys(COPY) as CopyKey[])
                .filter((k) => COPY[k].page === p.page)
                .map((k) => {
                  const v = latest.get(k);
                  const shown =
                    v?.body && fitsPiece(k, v.body) ? v.body : undefined;
                  return {
                    key: k,
                    label: COPY[k].label,
                    words: shown ?? COPY[k].text,
                    version: v?.id ?? 0,
                    spots: slotsOf(COPY[k].text),
                    editable: mayEdit(editor, k),
                  };
                }),
            }),
          ),
        };
      }),
  );

  server.registerTool(
    "copy_history",
    {
      title: "A piece's history",
      description:
        "Every saved version of one piece, newest first, with who saved it and when, and the original.",
      inputSchema: z.strictObject({ key: keySchema }),
      annotations: READ,
    },
    ({ key }) =>
      run("copy_history", false, async () => {
        const k = piece(key);
        const versions = await copyHistory(db(), k);
        return {
          key: k,
          original: COPY[k].text,
          versions: versions.slice(0, 50).map((v) => ({
            version: v.id,
            words: v.body,
            by: v.copy_key ? `key:${v.copy_key}` : `human:${v.human_id}`,
            at: v.created_at.toISOString(),
          })),
        };
      }),
  );

  server.registerTool(
    "edit_copy",
    {
      title: "Change a piece's words",
      description:
        "Saves new words for one piece. after: the version you read (list_copy's version), so a change someone made since isn't overwritten. Keep every {spot}.",
      inputSchema: z.strictObject({
        key: keySchema,
        words: z.string().max(MAX_COPY),
        after: z.number().int().min(0),
      }),
      annotations: WRITE,
    },
    ({ key, words, after }) =>
      run("edit_copy", true, async () => {
        assertWritable();
        const r = await saveCopy(db(), {
          key: piece(key),
          body: words,
          after,
          editor,
          ipHash,
        });
        if (r.changed) opts.saved();
        return { saved: r.changed, version: r.version };
      }),
  );

  server.registerTool(
    "restore_copy",
    {
      title: "Go back to earlier words",
      description:
        'Saves an earlier version\'s words, or the original ("original"), as the newest. To undo the last change, give the version before it. after: the version showing now.',
      inputSchema: z.strictObject({
        key: keySchema,
        version: z.union([z.number().int().min(1), z.literal("original")]),
        after: z.number().int().min(0),
      }),
      annotations: WRITE,
    },
    ({ key, version, after }) =>
      run("restore_copy", true, async () => {
        assertWritable();
        const k = piece(key);
        const body =
          version === "original" ? null : await versionBody(db(), k, version);
        const r = await saveCopy(db(), {
          key: k,
          body,
          after,
          editor,
          ipHash,
        });
        if (r.changed) opts.saved();
        return { saved: r.changed, version: r.version };
      }),
  );

  return server;
}
