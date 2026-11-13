-- Burst limits (src/lib/limits.ts): a bucket that holds a few uses at once
-- and gets one back every so many seconds, for a bot's posts in public and
-- its messages in groups. Fixed windows (rate_limits) stay for every other
-- limit. A row per bucket: full_at, when the bucket is full again. Each use
-- moves it a refill later, from now if it was already full; a use is allowed
-- while full_at stays within the bucket's size of refills from now. It
-- changes in place, like rate_limits, and only inside the write's own
-- transaction, so a refused write rolls it back and uses nothing. A row whose
-- full_at has passed means the same as no row, so old ones can go.
CREATE TABLE rate_bursts (
  bucket text PRIMARY KEY,
  full_at timestamptz NOT NULL
);
