-- Retention (design §5). Each maintenance statement ranges over one of these
-- and reads about one entry per row it changes.

-- Age rules, maxItems and archived feeds, per feed. Starred items never
-- enter it, so the rules never read them.
CREATE INDEX item_retain ON item(feed_id, is_read, id) WHERE status = 'ok' AND is_starred = 0;

-- pending -> error, error ages, archived feeds and the tombstone purge, per
-- feed. Holds every tombstone until it is deleted.
CREATE INDEX item_unsettled ON item(status, feed_id, id) WHERE status != 'ok';

DROP INDEX item_expiry;
