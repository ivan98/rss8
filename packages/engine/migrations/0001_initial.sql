CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);      -- config_hash, schema notes

CREATE TABLE feed (
  id              INTEGER PRIMARY KEY,   -- exposed to clients as feed/<id>
  key             TEXT NOT NULL UNIQUE,  -- stable id from rss8.config.ts
  source          TEXT NOT NULL,         -- which Source handles it
  options         TEXT,                  -- JSON, checked against the source's options
  state           TEXT,                  -- JSON, the source's own bookkeeping
  enabled         INTEGER NOT NULL DEFAULT 1,
  archived_at     INTEGER,               -- epoch ms
  title           TEXT NOT NULL,
  site_url        TEXT,
  feed_url        TEXT,
  icon_url        TEXT,
  last_fetched_at INTEGER,
  last_error      TEXT
);

CREATE TABLE feed_url (                  -- HTTP validators per fetched URL (a feed may fetch several)
  url           TEXT PRIMARY KEY,
  feed_id       INTEGER NOT NULL REFERENCES feed(id),
  etag          TEXT,
  last_modified TEXT
);

CREATE TABLE item (
  id           INTEGER PRIMARY KEY,      -- the id clients see (decimal; some send it back as 16-digit hex); also crawl order
  feed_id      INTEGER NOT NULL REFERENCES feed(id),
  guid         TEXT NOT NULL UNIQUE,     -- source-prefixed: '<source>-<native id>'
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | ok | error
  attempts     INTEGER NOT NULL DEFAULT 0,
  title        TEXT,
  url          TEXT,
  author       TEXT,
  summary      TEXT,
  content      TEXT,                     -- HTML fragment, no <html>/<body> wrapper
  published_at INTEGER,                  -- epoch seconds
  updated_at   INTEGER,
  crawled_at   INTEGER NOT NULL,         -- epoch ms; never decreases as id grows (the sync queries turn a time bound into an id bound)
  is_read      INTEGER NOT NULL DEFAULT 0,
  is_starred   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX item_unread  ON item(is_read, id, feed_id) WHERE status = 'ok';
CREATE INDEX item_feed    ON item(feed_id, id)          WHERE status = 'ok';
CREATE INDEX item_starred ON item(id)                   WHERE is_starred = 1;
CREATE INDEX item_crawled ON item(crawled_at);
CREATE INDEX item_expiry  ON item(published_at)         WHERE is_read = 1 AND is_starred = 0;
