import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { bindIdQuery, syncIdQueries, type IdQuery, type Page } from "../src/index";

const db = env.DB;

const ITEMS = 3000;
const DAY_MS = 86_400_000;
const START_MS = 1_700_000_000_000;
// Three items share each crawl time, 3,456 s apart: 1,000 steps over 40 days.
const STEP_MS = (40 * DAY_MS) / 1000;
const NOW_MS = START_MS + 40 * DAY_MS;
const daysAgo = (days: number) => (NOW_MS - days * DAY_MS) / 1000;

interface Row {
  id: number;
  feed_id: number;
  status: string;
  crawled_at: number;
  is_read: number;
  is_starred: number;
}

let rows: Row[] = [];

beforeAll(async () => {
  await db.batch([
    db.prepare("DELETE FROM item"),
    db.prepare("DELETE FROM feed"),
    db.prepare(
      "INSERT INTO feed (id, key, source, title) VALUES (1, 'feed-a', 'example', 'A'), (2, 'feed-b', 'example', 'B'), (3, 'feed-c', 'example', 'C')",
    ),
    // Newest five are still pending, as fresh items are; four in the middle
    // failed, one of them starred. Three in four items are read, one in fifty starred.
    db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO item (id, feed_id, guid, status, crawled_at, is_read, is_starred)
         SELECT i, 1 + i % 3, 'example-' || i,
                CASE WHEN i > ?1 - 5 THEN 'pending' WHEN i % 701 = 0 THEN 'error' ELSE 'ok' END,
                ?2 + (i / 3) * ?3,
                i % 4 <> 0,
                i % 50 = 0 OR i = 1402
         FROM n`,
      )
      .bind(ITEMS, START_MS, STEP_MS),
  ]);
  rows = (
    await db
      .prepare("SELECT id, feed_id, status, crawled_at, is_read, is_starred FROM item ORDER BY id DESC")
      .all<Row>()
  ).results;
});

const ok = (r: Row) => r.status === "ok";
const crawledSince = (otSeconds: number) => (r: Row) => r.crawled_at >= otSeconds * 1000;

// The ot-to-id lookup on item_crawled.
const LOOKUP = 1;
// The entry just past the range, read to find where the range ends. Absent
// when the range runs to the first entry of the index.
const END = 1;
// A primary key range or item_starred also holds non-ok rows; they are read,
// then dropped. item_unread and item_feed never hold them.
const nonOkFrom = (low: number, also: (r: Row) => boolean = () => true) =>
  rows.filter((r) => !ok(r) && also(r) && r.id >= low).length;

// Ties each case's params to its own query, so one table can mix queries.
function caseOf<P extends Page>(c: {
  name: string;
  query: IdQuery<P>;
  params: P;
  expected: (row: Row) => boolean;
  // Rows read beyond one per returned id, for the full (unpaged) result.
  extra: (returned: number[]) => number;
}) {
  return {
    name: c.name,
    expected: c.expected,
    extra: c.extra,
    run: (page: Partial<Page> = {}) => run(c.query, { ...c.params, ...page }),
    plan: () => plan(c.query, c.params),
  };
}

const cases = [
  ...[30, 7].map((days) =>
    caseOf({
      name: `reading list since ${days} days ago`,
      query: syncIdQueries.readingListSince,
      params: { otSeconds: daysAgo(days), limit: 100_000 },
      expected: (r) => ok(r) && crawledSince(daysAgo(days))(r),
      extra: (ids) => LOOKUP + END + nonOkFrom(Math.min(...ids)),
    }),
  ),
  caseOf({
    name: "unread",
    query: syncIdQueries.unread,
    params: { limit: 100_000 },
    expected: (r) => ok(r) && r.is_read === 0,
    extra: () => 0,
  }),
  caseOf({
    name: "starred",
    query: syncIdQueries.starred,
    params: { limit: 100_000 },
    expected: (r) => ok(r) && r.is_starred === 1,
    extra: () => nonOkFrom(0, (r) => r.is_starred === 1),
  }),
  ...[30, 7].map((days) =>
    caseOf({
      name: `read since ${days} days ago`,
      query: syncIdQueries.readSince,
      params: { otSeconds: daysAgo(days), limit: 100_000 },
      expected: (r) => ok(r) && r.is_read === 1 && crawledSince(daysAgo(days))(r),
      extra: () => LOOKUP + END,
    }),
  ),
  // A folder runs these once per feed. ot 0 is a stream without `ot`.
  ...[0, 7].flatMap((days) => {
    const otSeconds = days === 0 ? 0 : daysAgo(days);
    const since = days === 0 ? "" : ` since ${days} days ago`;
    // Another feed's entries follow feed 2's in both indexes.
    const extra = () => LOOKUP + END;
    return [
      caseOf({
        name: `one feed${since}`,
        query: syncIdQueries.feedSince,
        params: { feedId: 2, otSeconds, limit: 100_000 },
        expected: (r) => ok(r) && r.feed_id === 2 && crawledSince(otSeconds)(r),
        extra,
      }),
      caseOf({
        name: `one feed's unread${since}`,
        query: syncIdQueries.feedUnreadSince,
        params: { feedId: 2, otSeconds, limit: 100_000 },
        expected: (r) => ok(r) && r.feed_id === 2 && r.is_read === 0 && crawledSince(otSeconds)(r),
        extra,
      }),
    ];
  }),
];

async function run<P>(query: IdQuery<P>, params: P) {
  const result = await bindIdQuery(db, query, params).all<{ id: number }>();
  return { ids: result.results.map((r) => r.id), rowsRead: result.meta.rows_read };
}

async function plan<P>(query: IdQuery<P>, params: P): Promise<string[]> {
  const { results } = await db
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .bind(...query.params(params))
    .all<{ detail: string }>();
  return results.map((r) => r.detail);
}

describe.each(cases)("$name", (c) => {
  const want = () => rows.filter(c.expected).map((r) => r.id);

  it("uses an index or a primary key range, with no scan and no sort", async () => {
    const details = await c.plan();
    expect(details.join("\n")).toMatch(/USING (INTEGER PRIMARY KEY|INDEX|COVERING INDEX)/);
    for (const detail of details) {
      expect(detail).not.toMatch(/^SCAN/);
      expect(detail).not.toContain("TEMP B-TREE");
    }
  });

  it("returns every visible id, newest first, reading about one row per id", async () => {
    const { ids, rowsRead } = await c.run();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual(want());
    expect(rowsRead).toBe(ids.length + c.extra(ids));
  });

  it("pages with `before` into the same set, with no gap or duplicate", async () => {
    const limit = Math.ceil(want().length / 5);
    const { rowsRead: fullRowsRead } = await c.run();
    const pages: number[][] = [];
    let before: number | undefined;
    let rowsRead = 0;
    for (;;) {
      const page = await c.run({ limit, before });
      if (page.ids.length === 0) break;
      expect(page.ids.length).toBeLessThanOrEqual(limit);
      pages.push(page.ids);
      rowsRead += page.rowsRead;
      before = page.ids.at(-1);
    }
    // Each page may repeat the lookup and read one entry past its range.
    expect(rowsRead).toBeLessThanOrEqual(fullRowsRead + pages.length * 2);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(want());
  });
});

describe("ot bound", () => {
  it("includes items crawled exactly at ot, and the earliest of tied crawl times", async () => {
    const tied = rows.filter((r) => r.crawled_at === START_MS + 500 * STEP_MS).map((r) => r.id);
    expect(tied).toHaveLength(3);

    const { ids } = await run(syncIdQueries.readingListSince, {
      otSeconds: (START_MS + 500 * STEP_MS) / 1000,
      limit: 100_000,
    });

    expect(Math.min(...ids)).toBe(Math.min(...tied));
  });

  it("returns nothing when ot is newer than every item", async () => {
    const params = { otSeconds: NOW_MS / 1000 + 1, limit: 100_000 };
    expect((await run(syncIdQueries.readingListSince, params)).ids).toEqual([]);
    expect((await run(syncIdQueries.readSince, params)).ids).toEqual([]);
  });
});
