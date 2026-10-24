-- 9,000 fake items for measuring the Google Reader API at realistic size
-- (design §11 step 5; shaped like Phase 0's 0.10 dataset): 4 feeds, crawl
-- times spread evenly over the last 30 days, the newest 1,500 unread, 53
-- starred, and a 5.6 KB body each (about 50 MB in total).
--
-- Only for an empty, throwaway database. Never run it against production.
-- 55,508 rows written, measured locally: each item also writes its index entries.

INSERT INTO feed (id, key, source, title, site_url, feed_url) VALUES
  (1, 'bench-1', 'bench', 'Bench feed 1', 'https://example.com/1', 'https://example.com/1/feed'),
  (2, 'bench-2', 'bench', 'Bench feed 2', 'https://example.com/2', 'https://example.com/2/feed'),
  (3, 'bench-3', 'bench', 'Bench feed 3', 'https://example.com/3', 'https://example.com/3/feed'),
  (4, 'bench-4', 'bench', 'Bench feed 4', 'https://example.com/4', 'https://example.com/4/feed');

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
INSERT INTO item (id, feed_id, guid, status, title, url, author, summary, content, published_at, crawled_at, is_read, is_starred)
SELECT i, 1 + i % 4, 'bench-' || i, 'ok', 'Item ' || i, 'https://example.com/item/' || i, 'Author', 'Summary of item ' || i,
       '<p>' || substr(replace(hex(zeroblob(2000)), '0', 'lorem ipsum '), 1, 5600) || '</p>',
       unixepoch('now') - (9000 - i) * 288, (unixepoch('now') - (9000 - i) * 288) * 1000,
       i <= 7500, i % 170 = 1
FROM n;

WITH RECURSIVE n(i) AS (SELECT 1001 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
INSERT INTO item (id, feed_id, guid, status, title, url, author, summary, content, published_at, crawled_at, is_read, is_starred)
SELECT i, 1 + i % 4, 'bench-' || i, 'ok', 'Item ' || i, 'https://example.com/item/' || i, 'Author', 'Summary of item ' || i,
       '<p>' || substr(replace(hex(zeroblob(2000)), '0', 'lorem ipsum '), 1, 5600) || '</p>',
       unixepoch('now') - (9000 - i) * 288, (unixepoch('now') - (9000 - i) * 288) * 1000,
       i <= 7500, i % 170 = 1
FROM n;

WITH RECURSIVE n(i) AS (SELECT 2001 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
INSERT INTO item (id, feed_id, guid, status, title, url, author, summary, content, published_at, crawled_at, is_read, is_starred)
SELECT i, 1 + i % 4, 'bench-' || i, 'ok', 'Item ' || i, 'https://example.com/item/' || i, 'Author', 'Summary of item ' || i,
       '<p>' || substr(replace(hex(zeroblob(2000)), '0', 'lorem ipsum '), 1, 5600) || '</p>',
       unixepoch('now') - (9000 - i) * 288, (unixepoch('now') - (9000 - i) * 288) * 1000,
       i <= 7500, i % 170 = 1
FROM n;

WITH RECURSIVE n(i) AS (SELECT 3001 UNION ALL SELECT i + 1 FROM n WHERE i < 4000)
INSERT INTO item (id, feed_id, guid, status, title, url, author, summary, content, published_at, crawled_at, is_read, is_starred)
SELECT i, 1 + i % 4, 'bench-' || i, 'ok', 'Item ' || i, 'https://example.com/item/' || i, 'Author', 'Summary of item ' || i,
       '<p>' || substr(replace(hex(zeroblob(2000)), '0', 'lorem ipsum '), 1, 5600) || '</p>',
       unixepoch('now') - (9000 - i) * 288, (unixepoch('now') - (9000 - i) * 288) * 1000,
       i <= 7500, i % 170 = 1
FROM n;

WITH RECURSIVE n(i) AS (SELECT 4001 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
INSERT INTO item (id, feed_id, guid, status, title, url, author, summary, content, published_at, crawled_at, is_read, is_starred)
SELECT i, 1 + i % 4, 'bench-' || i, 'ok', 'Item ' || i, 'https://example.com/item/' || i, 'Author', 'Summary of item ' || i,
       '<p>' || substr(replace(hex(zeroblob(2000)), '0', 'lorem ipsum '), 1, 5600) || '</p>',
       unixepoch('now') - (9000 - i) * 288, (unixepoch('now') - (9000 - i) * 288) * 1000,
       i <= 7500, i % 170 = 1
FROM n;

WITH RECURSIVE n(i) AS (SELECT 5001 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
INSERT INTO item (id, feed_id, guid, status, title, url, author, summary, content, published_at, crawled_at, is_read, is_starred)
SELECT i, 1 + i % 4, 'bench-' || i, 'ok', 'Item ' || i, 'https://example.com/item/' || i, 'Author', 'Summary of item ' || i,
       '<p>' || substr(replace(hex(zeroblob(2000)), '0', 'lorem ipsum '), 1, 5600) || '</p>',
       unixepoch('now') - (9000 - i) * 288, (unixepoch('now') - (9000 - i) * 288) * 1000,
       i <= 7500, i % 170 = 1
FROM n;

WITH RECURSIVE n(i) AS (SELECT 6001 UNION ALL SELECT i + 1 FROM n WHERE i < 7000)
INSERT INTO item (id, feed_id, guid, status, title, url, author, summary, content, published_at, crawled_at, is_read, is_starred)
SELECT i, 1 + i % 4, 'bench-' || i, 'ok', 'Item ' || i, 'https://example.com/item/' || i, 'Author', 'Summary of item ' || i,
       '<p>' || substr(replace(hex(zeroblob(2000)), '0', 'lorem ipsum '), 1, 5600) || '</p>',
       unixepoch('now') - (9000 - i) * 288, (unixepoch('now') - (9000 - i) * 288) * 1000,
       i <= 7500, i % 170 = 1
FROM n;

WITH RECURSIVE n(i) AS (SELECT 7001 UNION ALL SELECT i + 1 FROM n WHERE i < 8000)
INSERT INTO item (id, feed_id, guid, status, title, url, author, summary, content, published_at, crawled_at, is_read, is_starred)
SELECT i, 1 + i % 4, 'bench-' || i, 'ok', 'Item ' || i, 'https://example.com/item/' || i, 'Author', 'Summary of item ' || i,
       '<p>' || substr(replace(hex(zeroblob(2000)), '0', 'lorem ipsum '), 1, 5600) || '</p>',
       unixepoch('now') - (9000 - i) * 288, (unixepoch('now') - (9000 - i) * 288) * 1000,
       i <= 7500, i % 170 = 1
FROM n;

WITH RECURSIVE n(i) AS (SELECT 8001 UNION ALL SELECT i + 1 FROM n WHERE i < 9000)
INSERT INTO item (id, feed_id, guid, status, title, url, author, summary, content, published_at, crawled_at, is_read, is_starred)
SELECT i, 1 + i % 4, 'bench-' || i, 'ok', 'Item ' || i, 'https://example.com/item/' || i, 'Author', 'Summary of item ' || i,
       '<p>' || substr(replace(hex(zeroblob(2000)), '0', 'lorem ipsum '), 1, 5600) || '</p>',
       unixepoch('now') - (9000 - i) * 288, (unixepoch('now') - (9000 - i) * 288) * 1000,
       i <= 7500, i % 170 = 1
FROM n;
