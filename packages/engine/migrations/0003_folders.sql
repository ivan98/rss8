-- Folders (design §6, Folders). The folder name and the feed's index in the
-- config, both written by the config sync.
ALTER TABLE feed ADD COLUMN category TEXT;
ALTER TABLE feed ADD COLUMN position INTEGER;

-- A feed's or folder's unread stream, per feed. item_retain leaves out
-- starred items, and item_unread would read every other feed's unread rows.
CREATE INDEX item_feed_unread ON item(feed_id, id) WHERE status = 'ok' AND is_read = 0;
