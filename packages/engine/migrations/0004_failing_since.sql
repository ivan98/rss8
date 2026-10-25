-- The system feed (design §4, System feed). When a feed's discover last
-- failed for good, epoch ms; NULL while it works. Set and cleared with a
-- guarded UPDATE, so "started failing" and "recovered" are each posted once.
ALTER TABLE feed ADD COLUMN failing_since INTEGER;
