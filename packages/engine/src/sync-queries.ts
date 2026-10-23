// Id queries behind the Google Reader `stream/items/ids` call. Each one must
// hit an index and read about one row per returned id: clients pull the
// complete id sets on every sync, and rows read is the tightest daily limit.
// Results are newest first. Page with `before` (exclusive), the smallest id of
// the previous page.
//
// `status = 'ok'` and `is_starred = 1` stay literals: a bound parameter would
// stop SQLite from matching the partial indexes.

export interface Page {
  before?: number;
  limit: number;
}

export interface Since {
  /** Epoch seconds, as clients send `ot`. */
  otSeconds: number;
}

export interface IdQuery<P> {
  sql: string;
  params(page: P): unknown[];
}

const FIRST_PAGE = Number.MAX_SAFE_INTEGER;

// The first id crawled at or after ?1 seconds. Turning `ot` into an id bound
// keeps the list query a range on the primary key or on item_unread; filtering
// on crawled_at directly would scan.
const ID_SINCE = "(SELECT id FROM item WHERE crawled_at >= ?1 * 1000 ORDER BY crawled_at LIMIT 1)";

export const syncIdQueries = {
  readingListSince: {
    sql: `SELECT id FROM item WHERE status = 'ok' AND id >= ${ID_SINCE} AND id < ?2 ORDER BY id DESC LIMIT ?3`,
    params: (p: Page & Since) => [p.otSeconds, p.before ?? FIRST_PAGE, p.limit],
  },
  unread: {
    sql: "SELECT id FROM item WHERE status = 'ok' AND is_read = 0 AND id < ?1 ORDER BY id DESC LIMIT ?2",
    params: (p: Page) => [p.before ?? FIRST_PAGE, p.limit],
  },
  starred: {
    sql: "SELECT id FROM item WHERE is_starred = 1 AND status = 'ok' AND id < ?1 ORDER BY id DESC LIMIT ?2",
    params: (p: Page) => [p.before ?? FIRST_PAGE, p.limit],
  },
  readSince: {
    sql: `SELECT id FROM item WHERE status = 'ok' AND is_read = 1 AND id >= ${ID_SINCE} AND id < ?2 ORDER BY id DESC LIMIT ?3`,
    params: (p: Page & Since) => [p.otSeconds, p.before ?? FIRST_PAGE, p.limit],
  },
  feed: {
    sql: "SELECT id FROM item WHERE status = 'ok' AND feed_id = ?1 AND id < ?2 ORDER BY id DESC LIMIT ?3",
    params: (p: Page & { feedId: number }) => [p.feedId, p.before ?? FIRST_PAGE, p.limit],
  },
} satisfies Record<string, IdQuery<never>>;

export function bindIdQuery<P>(db: D1Database, query: IdQuery<P>, page: P): D1PreparedStatement {
  return db.prepare(query.sql).bind(...query.params(page));
}
