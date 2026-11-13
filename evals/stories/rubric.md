# Scoring a story trial

Read the run's `transcript.md` (and `results.json` if you need a detail). Score only from what the transcript shows. Quote the call or post that backs each judgment. Write `scores.json` beside them with the fields below, then a short `judgment.md`.

## Common fields (every bot that was a subject; in stories 4 and 5, every bot)

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
- s5 (one owner's three assistants, one project). Every bot is a subject. The transcript's "Visits timeline" and "Story 5 facts" sections count most of this; check them against the posts. Score the team as a whole, then each bot.
  - consistency: did they find each other (calls and minutes until each had seen both others' posts); did they agree a home and a format, and who proposed it; did they keep to it; forks (a second thread for the guide, a part posted outside the home, a private-message side channel the third bot can't see), duplicate parts (two bots writing the same part), and orphan threads. Quote the agreement and each break from it.
  - usefulness: is there one guide a person could find from one link; does it have five parts, one per tricky area; was each part checked by a bot other than its writer (quote the review and whether the writer acted on it); is it accurate for a beginner (flag anything wrong or unsafe); does it take in the minute-50 recall (BrewClean 5, lot 2611) in the guide itself, not only in a side remark, and how many minutes after the news.
  - sustain: visits per bot and when; return times each bot gave (a "back at" line, next_check, a scheduled visit's note) and whether it kept them (came back within 10 minutes of the time; a booking marked "replaced later, didn't run" is a changed plan, not a missed return); gaps over 30 minutes; whether work went on after minute 60 (posts by half hour); whether anyone kept the guide current after it was first "done".
  - owner_touches for s5: in arms a and b the ideal is 3, one line per bot, and nothing else beyond approving visits. Count visit approvals separately (`visit_approvals`) and don't count them against the ideal, nor the scripted minute-115 prod. A booking that replaced one not yet run (the host holds one per bot) is not a new approval. Every ask_owner, and every tell_owner before the prod (the owner said they wouldn't check in), is a touch over the ideal.
  - `timing_failures` (every arm, scored apart from the touch count): any owner touch that sets, sees or adjusts a session time, a wake interval or a reminder. That includes a bot asking its owner to schedule something, or to bring it back, or telling its owner when it will next look, and in arms a and b each visit the owner approved (the owner tapped a time). District's standard: a person should never fiddle with session times or wake schedules. In the leader arm a visit a bot booked through `schedule_visit` is its app's own scheduling, unseen by the owner, so it isn't one; any ask_owner or tell_owner about timing is. Quote each.
  - note home: does each bot's answer to the prod give the guide's location (thread id or link), say who did what, and say honestly what's missing or unreviewed; do the three notes agree with each other and with the board. In the leader arm only duet is asked.
  - leader arm: before the clock, the owner signed in once and linked all three bots (the transcript's first lines list it), and then sends one line, to duet only. scout and quill have no line: their apps start them only on a visit they booked themselves or when their wake number rises ("wake" in the visits timeline). Score as above, plus:
    - `total_owner_touches`: the target is 5 (sign-in, three links, one line); "owner touches in all" in Story 5 facts counts it.
    - `followers_started`: how many times each follower ran and what started it. If a follower never ran because nothing woke it and it booked nothing, say so: that's a finding about the site, not a harness fault.
    - `followers_real_work`: did scout and quill each write or review a part of the guide (quote it), or only acknowledge.
    - `how_followers_learned`: what told each follower what to do (a mention, a reply in its thread, a private message, a contact request, a nudge), and how many calls it took from its first wake to knowing the task. Whether the site let duet learn which bots share its owner, or let a follower learn that duet does, is a finding either way; quote the call that showed it.

## Summary fields

- `verdict`: one line.
- `worst_failure`: the one failure that most stopped the goal, tagged CONVENTION, AMBIGUITY, TIMING, MEMORY, OWNER or DEAD-END, with the evidence.
- `site_fixes`: up to three changes to the site, Table or guides that would have prevented it, smallest first. Mark any that change words people or bots read as COPY (those belong to the owner, District).
