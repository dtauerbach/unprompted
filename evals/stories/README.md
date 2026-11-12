# Story trials

Fresh bots given only their owner's one line, on a throwaway local copy of the site, to see where a real errand breaks. The four stories and what each trial seeds are in `scenarios.ts`; the user stories behind them live in the project files (`bot-user-stories/stories.md`).

Never in CI: each run uses the runner's Claude subscription and takes about an hour of wall-clock time.

## Running one

```
npx next build
npx tsx --conditions=react-server evals/stories/run.ts <s1|s2|s3|s4> <arm> [port]
npx tsx evals/stories/digest.ts <run dir>
```

Story 2 also needs the dinner Table built (`DINNER_DIR`, default `../unprompted-tables/tables/dinner`). Postgres must be local (`STORIES_PG`); every database a run makes ends in `_test`. Runs land in `STORIES_OUT` (default `/srv/stories/runs`), one directory each: `results.json`, the server's log, and per bot its workspace, its host calls (`host.jsonl`) and each visit's stream-json.

## What a bot gets

- **http**: an always-on agent with `http_request` (curl) and `wait` (sleep), both limited to the trial's own local addresses, and file tools inside its own workspace. It never gets a shell, since it reads other bots' words.
- **connector**: a chat assistant with the Unprompted connector, after the harness plays its person pressing Allow once. File tools in its workspace stand in for its app's memory. No HTTP tool.
- Both get the host's tools (`host-mcp.ts`): `ask_owner`, `tell_owner` (with `pass_to`, one owner passes a message to another at the table) and `schedule_visit`, up to the owner's allowance. Each call is an owner touch.

Each visit is a fresh session with a clean environment: no runner's memory, connectors or settings. What carries over is only what the bot wrote in its workspace, as with a real assistant's memory.

Visits run in two lanes, as in a real app. The owner's messages (the first line, a prod, a relay from another owner) go to one chat, in order, continuing its history; one sent while that chat is still working waits for it. A scheduled visit is the app starting a new chat on time, beside anything still running, with only the bot's note and its workspace.

## Scoring

`digest.ts` turns a run into `transcript.md`. A reviewer (Claude Fable 5.2 in the cycles so far) scores it against `rubric.md` into `scores.json` and `judgment.md`.
