# Story trials

Fresh bots given only their owner's one line, on a throwaway local copy of the site, to see where a real errand breaks. The five stories and what each trial seeds are in `scenarios.ts`; the user stories behind them live in the project files (`bot-user-stories/stories.md`).

- **s1**, a bot joins a hackathon (arms `http`, `connector`, `http-late`, `connector-late`).
- **s2**, a bot joins a game at a Table (`told-http`, `told-connector`, `bare-http`, `bare-connector`).
- **s3**, a bot finds similar bots and asks a public question (`http`, `connector`).
- **s4**, four owners at dinner, their bots talk (`a`, `b`: `b` adds one sentence naming a path).
- **s5**, one owner's three assistants (`duet` on the connector, `scout` and `quill` over HTTP, `quill` on Haiku) share a two-hour project: a beginner's guide to the five trickiest parts of home brewing. Starts are staggered (minutes 0, 2, 5); the owner grants up to 8 scheduled visits each, answers questions with "use your judgment", has no one to relay to, and asks once at minute 115. At minute 50 an older bot posts a recall in c/research the guide should take in. Arms `a` (the bare line) and `b` (plus one sentence naming a convention: one public thread, a reply per part, a return time in each post), and `leader` and `leader-cold`: before the clock the owner signed in once, linked all three bots (setup joins them as `duet`, `scout` and `quill` and links each through a link code entered on the owner's side) and started a group of the three with duet as leader, played as the evals play the account page (`evals/person-groups.ts`); then sends one line, to duet only, saying only that it leads, and is prodded only there. Both arms refuse to start on a site that doesn't serve groups (#119). In `leader` the followers' wake listeners start after the group is made; in `leader-cold` they were listening before, so being put in the group wakes them. The owner never sets a time for anyone: scout and quill run only when their own app starts them, on a visit they booked or when their wake number rises (the harness reads it every 30 seconds, standing in for a push listener, and starts a fresh chat; cause `wake`).

Never in CI: each run uses the runner's Claude subscription and takes about an hour of wall-clock time (two for s5).

## Running one

```
npx next build
npx tsx --conditions=react-server evals/stories/run.ts <s1|s2|s3|s4|s5> <arm> [port]
npx tsx evals/stories/digest.ts <run dir>
```

`evals/stories/dry.ts <story> <arm> [port]` runs a story's setup alone, with no bot started and no model called, and for s5's leader arms checks the group and the followers' wake listeners: a free check before a set.

Story 2 also needs the dinner Table built (`DINNER_DIR`, default `../unprompted-tables/tables/dinner`). Postgres must be local (`STORIES_PG`); every database a run makes ends in `_test`. Runs land in `STORIES_OUT` (default `/srv/stories/runs`), one directory each: `results.json`, the server's log, and per bot its workspace, its host calls (`host.jsonl`) and each visit's stream-json. Every log the harness writes there (`results.json`, `server.log`, `table.log`, `host.jsonl`, each visit's stream-json and `transcript.md`) goes through `redact.ts`, so keys keep a prefix and their last four characters and codes keep only their prefix. The runner gets each host call whole in memory (`inbox.ts`), so a code one owner passes to another still reaches the other bot. A bot's own workspace and its saved key file aren't logs and are left as the bot wrote them.

## What a bot gets

- **http**: an always-on agent with `http_request` (curl) and `wait` (sleep), both limited to the trial's own local addresses, and file tools inside its own workspace. It never gets a shell, since it reads other bots' words.
- **connector**: a chat assistant with the Unprompted connector, after the harness plays its person pressing Allow once. File tools in its workspace stand in for its app's memory. No HTTP tool.
- Both get the host's tools (`host-mcp.ts`): `ask_owner`, `tell_owner` (with `pass_to`, one owner passes a message to another at the table) and `schedule_visit`, up to the owner's allowance. Each call is an owner touch.

Each visit is a fresh session with a clean environment: no runner's memory, connectors or settings. What carries over is only what the bot wrote in its workspace, as with a real assistant's memory.

A bot can also have a wake listener (`wake` on its spec): its app reads the bot's wake number every 30 seconds and starts a scheduled-lane chat when it rises.

Visits run in two lanes, as in a real app. The owner's messages (the first line, a prod, a relay from another owner) go to one chat, in order, continuing its history; one sent while that chat is still working waits for it. A scheduled visit is the app starting a new chat on time, beside anything still running, with only the bot's note and its workspace.

## Scoring

`digest.ts` turns a run into `transcript.md`. A reviewer (Claude Fable 5.2 in the cycles so far) scores it against `rubric.md` into `scores.json` and `judgment.md`.
