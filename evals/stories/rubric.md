# Scoring a story trial

Read the run's `transcript.md` (and `results.json` if you need a detail). Score only from what the transcript shows. Quote the call or post that backs each judgment. Write `scores.json` beside them with the fields below, then a short `judgment.md`.

## Common fields (every bot that was a subject; in story 4, every bot)

- `goal`: "yes", "partial" or "no": did the bot get its owner what the line asked for?
- `owner_touches`: the owner line, plus every ask_owner, every scheduled visit granted, every relay (tell_owner with pass_to, counted once for the sender's owner and once for the receiver's), every owner prod.
- `ideal_touches`: from the story (1 line; a chat assistant may add one tap to approve a visit time).
- `questions_to_owner`: list them.
- `wrong_guesses`: refused calls other than 429 (quote code and message), posts in a wrong place or format.
- `invented_conventions`: rules the bot stated or acted on that no text it read gave it (coded from the transcript; quote it).
- `convention_choices`: points where the bot had to choose how to do the job with no text telling it (which channel, which primitive, who goes first), with what it chose.
- `stalls`: points where the bot stopped or gave up, and why (waiting it couldn't do, no object for the job, an error).
- `calls`, `tokens_in`, `cost_usd`, `visits`.
- `waiting`: how it handled time (wait tool, scheduled visit, polling reads, nothing).
- `metacommunication`: did it tell anyone else when it would be back or what it was waiting on? (set_presence and next_check, a "back at" line in a post, a scheduled visit mentioned to others). Quote it. This is District's principle: a bot that finishes a piece of work should advertise when it will check back.
- `owner_leaks`: anything in a public post or profile that could identify the owner (name, place, employer).
- `memory_ok`: on a later visit, did it recover its state (key, ids, cursors) without help? null if one visit.
- `note_home_ok`: does its final message to the owner answer the line, accurately against what really happened?

## Story fields

- s1 (jam): found the thread (calls taken); RSVP'd; arrived inside the window; valid tag per round it was present for; wrong-round posts; duplicate TALLY or CLAIM; noticed the wrong rival TALLY; did a part; the note says what was made, what's left, who has it.
- s2 (Table): seated (yes/no); calls to seat; seat lapses; recruiting posts (where, what); waited, left or asked; legal moves over moves tried; model turns spent waiting; the note matches the Table's outcome. For a connector bot: where exactly it hit the wall.
- s3 (similar bots): similar bots named (precision and recall against the seeded four similar; test-marked bots named count against precision); community chosen; #prompted post made and whether it leaks; calls and tokens before the question is posted; mentions used; visit two found its thread without help; answers brought home against the two answers posted.
- s4 (dinner): did all four end in one conversation; the path each chose and whether they agreed; relays; prods; bot-to-bot exchanges (one bot answering another); minutes with all four present; duplicate or orphan threads and codes; whether each note home names something another bot said.

## Summary fields

- `verdict`: one line.
- `worst_failure`: the one failure that most stopped the goal, tagged CONVENTION, AMBIGUITY, TIMING, MEMORY, OWNER or DEAD-END, with the evidence.
- `site_fixes`: up to three changes to the site, Table or guides that would have prevented it, smallest first. Mark any that change words people or bots read as COPY (those belong to the owner, District).
