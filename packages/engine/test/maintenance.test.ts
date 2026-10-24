import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MAINTENANCE_LIMITS, bindIdQuery, runMaintenance, syncIdQueries, type Config } from "../src/index";
import { maintenanceSql } from "../src/maintenance";

const db = env.DB;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

type Status = "ok" | "pending" | "error" | "purged";

const FEEDS = { a: 1, b: 2, c: 3, d: 4, e: 5 } as const;
type FeedName = keyof typeof FEEDS;

// a and d override part of the defaults; c is archived; e is in D1 but not in
// the config, as a feed is between its removal and the next config sync.
const config: Config = {
  timezone: "UTC",
  retention: { readDays: 30, unreadDays: 90, maxItems: 1000 },
  tombstoneDays: 365,
  feeds: [
    { key: "feed-a", source: "example", enabled: true, retention: { readDays: 60, unreadDays: 30 } },
    { key: "feed-b", source: "example", enabled: true },
    { key: "feed-d", source: "example", enabled: true, retention: { maxItems: 3 } },
  ],
};

interface Seed {
  guid: string;
  feed: FeedName;
  ageMs: number;
  read?: boolean;
  starred?: boolean;
  status?: Status;
}

const item = (guid: string, feed: FeedName, ageDays: number, rest: Partial<Seed> = {}): Seed => ({
  guid,
  feed,
  ageMs: ageDays * DAY,
  ...rest,
});

interface ItemRow {
  id: number;
  guid: string;
  status: Status;
  title: string | null;
  url: string | null;
  author: string | null;
  summary: string | null;
  content: string | null;
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM item"),
    db.prepare("DELETE FROM feed"),
    db.prepare(
      `INSERT INTO feed (id, key, source, title, archived_at) VALUES
       (1, 'feed-a', 'example', 'A', NULL), (2, 'feed-b', 'example', 'B', NULL),
       (3, 'feed-c', 'example', 'C', ?1), (4, 'feed-d', 'example', 'D', NULL),
       (5, 'feed-e', 'example', 'E', NULL)`,
    ).bind(NOW - DAY),
  ]);
});

// Ids follow crawl order, oldest first, as the engine assigns them.
async function seed(items: Seed[]): Promise<void> {
  const rows = [...items]
    .sort((x, y) => y.ageMs - x.ageMs)
    .map((s, i) => ({
      id: i + 1,
      feed: FEEDS[s.feed],
      guid: s.guid,
      status: s.status ?? "ok",
      crawled: NOW - s.ageMs,
      read: s.read ? 1 : 0,
      starred: s.starred ? 1 : 0,
    }));
  await db
    .prepare(
      `INSERT INTO item (id, feed_id, guid, status, crawled_at, is_read, is_starred, title, url, author, summary, content)
       SELECT value ->> 'id', value ->> 'feed', value ->> 'guid', value ->> 'status', value ->> 'crawled',
              value ->> 'read', value ->> 'starred', 'title', 'https://example.com/', 'author', 'summary', '<p>content</p>'
       FROM json_each(?1)`,
    )
    .bind(JSON.stringify(rows))
    .run();
}

async function items(): Promise<Map<string, ItemRow>> {
  const { results } = await db
    .prepare("SELECT id, guid, status, title, url, author, summary, content FROM item")
    .all<ItemRow>();
  return new Map(results.map((r) => [r.guid, r]));
}

// Runs maintenance and returns what changed: guid -> new status, or "deleted".
async function changes(
  run: () => Promise<unknown> = () => runMaintenance(db, config, NOW),
): Promise<Record<string, Status | "deleted">> {
  const before = await items();
  await run();
  const after = await items();
  const diff: Record<string, Status | "deleted"> = {};
  for (const [guid, row] of before) {
    const now = after.get(guid);
    if (!now) diff[guid] = "deleted";
    else if (now.status !== row.status) diff[guid] = now.status;
  }
  return diff;
}

describe("read items", () => {
  it("are tombstoned after the feed's readDays, from crawled_at", async () => {
    await seed([
      item("b-read-past", "b", 30, { read: true, ageMs: 30 * DAY + 1 }),
      item("b-read-at", "b", 30, { read: true }),
      item("b-read-newer", "b", 29, { read: true }),
      item("b-read-starred", "b", 200, { read: true, starred: true }),
      item("b-unread-past", "b", 31),
      item("a-read-past-default", "a", 31, { read: true }),
      item("a-read-past-own", "a", 61, { read: true }),
      item("e-read-past", "e", 31, { read: true }),
    ]);

    expect(await changes()).toEqual({
      "b-read-past": "purged",
      "a-read-past-own": "purged",
      "e-read-past": "purged",
    });
  });
});

describe("unread items", () => {
  it("are tombstoned after the feed's unreadDays", async () => {
    await seed([
      item("b-unread-past", "b", 90, { ageMs: 90 * DAY + 1 }),
      item("b-unread-at", "b", 90),
      item("b-unread-default-not-own", "b", 31),
      item("b-unread-starred", "b", 200, { starred: true }),
      item("a-unread-past-own", "a", 31),
      item("a-unread-at-own", "a", 30),
    ]);

    expect(await changes()).toEqual({
      "b-unread-past": "purged",
      "a-unread-past-own": "purged",
    });
  });

  it("are all tombstoned when every item is older than the cutoff", async () => {
    await seed([item("b-old-1", "b", 300), item("b-old-2", "b", 200)]);

    expect(await changes()).toEqual({ "b-old-1": "purged", "b-old-2": "purged" });
  });
});

describe("maxItems", () => {
  it("keeps the newest non-starred ok items of the feed and tombstones the rest", async () => {
    await seed([
      item("d-1", "d", 5, { read: true }),
      item("d-2", "d", 4),
      item("d-3-starred", "d", 3.5, { starred: true }),
      item("d-4", "d", 3, { read: true }),
      item("d-5-pending", "d", 0.5, { status: "pending" }),
      item("d-6-error", "d", 0.4, { status: "error" }),
      item("d-7", "d", 2),
      item("d-8", "d", 1),
      item("b-1", "b", 5),
      item("b-2", "b", 4),
      item("b-3", "b", 3),
      item("b-4", "b", 2),
    ]);

    expect(await changes()).toEqual({ "d-1": "purged", "d-2": "purged" });
  });
});

describe("an archived feed", () => {
  it("has every non-starred item tombstoned, whatever its status and age", async () => {
    await seed([
      item("c-read", "c", 1, { read: true }),
      item("c-unread", "c", 2),
      item("c-pending", "c", 0.1, { status: "pending" }),
      item("c-error", "c", 3, { status: "error" }),
      item("c-starred", "c", 4, { starred: true }),
      item("c-starred-read", "c", 400, { starred: true, read: true }),
      item("b-unread", "b", 2),
      item("b-pending", "b", 0.1, { status: "pending" }),
      item("b-error", "b", 3, { status: "error" }),
    ]);

    expect(await changes()).toEqual({
      "c-read": "purged",
      "c-unread": "purged",
      "c-pending": "purged",
      "c-error": "purged",
    });
  });
});

describe("pending items", () => {
  it("become errors after a day", async () => {
    await seed([
      item("b-pending-past", "b", 1, { status: "pending", ageMs: DAY + 1 }),
      item("b-pending-at", "b", 1, { status: "pending" }),
      item("b-pending-new", "b", 0.5, { status: "pending" }),
      item("a-pending-past", "a", 2, { status: "pending" }),
    ]);

    const report = await runMaintenance(db, config, NOW);
    expect(report).toEqual({ tombstoned: 0, deleted: 0, erred: 2 });
    const after = await items();
    expect(after.get("b-pending-past")?.status).toBe("error");
    expect(after.get("a-pending-past")?.status).toBe("error");
    expect(after.get("b-pending-at")?.status).toBe("pending");
    expect(after.get("b-pending-new")?.status).toBe("pending");
  });
});

describe("error items", () => {
  it("are tombstoned after the feed's readDays", async () => {
    await seed([
      item("b-error-past", "b", 30, { status: "error", ageMs: 30 * DAY + 1 }),
      item("b-error-at", "b", 30, { status: "error" }),
      item("b-error-starred", "b", 100, { status: "error", starred: true }),
      item("a-error-default-not-own", "a", 31, { status: "error" }),
      item("a-error-past-own", "a", 61, { status: "error" }),
    ]);

    expect(await changes()).toEqual({ "b-error-past": "purged", "a-error-past-own": "purged" });
  });
});

describe("tombstones", () => {
  it("clear the content but keep the guid, which still blocks a re-insert", async () => {
    await seed([item("b-old", "b", 100, { read: true })]);
    await runMaintenance(db, config, NOW);

    const row = (await items()).get("b-old");
    expect(row).toMatchObject({ status: "purged", title: null, url: null, author: null, summary: null, content: null });

    const insert = await db
      .prepare(
        "INSERT OR IGNORE INTO item (feed_id, guid, status, crawled_at, title) VALUES (2, 'b-old', 'pending', ?1, 'again')",
      )
      .bind(NOW)
      .run();
    expect(insert.meta.changes).toBe(0);
    expect((await items()).get("b-old")).toEqual(row);
  });

  it("are deleted after tombstoneDays; newer ones and starred ones stay", async () => {
    await seed([
      item("b-tomb-past", "b", 365, { status: "purged", ageMs: 365 * DAY + 1 }),
      item("b-tomb-at", "b", 365, { status: "purged" }),
      item("b-tomb-new", "b", 40, { status: "purged" }),
      item("b-tomb-starred", "b", 500, { status: "purged", starred: true }),
      item("a-tomb-past", "a", 400, { status: "purged" }),
    ]);

    const report = await runMaintenance(db, config, NOW);
    expect(report).toEqual({ tombstoned: 0, deleted: 2, erred: 0 });
    expect([...(await items()).keys()].sort()).toEqual(["b-tomb-at", "b-tomb-new", "b-tomb-starred"]);
  });

  it("never appear in a sync id query", async () => {
    await seed([
      ...Array.from({ length: 40 }, (_, i) =>
        item(`b-${i}`, "b", 2 + i * 3, { read: i % 2 === 0, starred: i % 7 === 0 }),
      ),
      item("c-starred", "c", 1, { starred: true }),
      item("c-unread", "c", 1),
    ]);
    await runMaintenance(db, config, NOW);
    const purged = new Set(
      (await db.prepare("SELECT id FROM item WHERE status = 'purged'").all<{ id: number }>()).results.map((r) => r.id),
    );
    expect(purged.size).toBeGreaterThan(10);

    const pages = [
      bindIdQuery(db, syncIdQueries.readingListSince, { otSeconds: 0, limit: 100_000 }),
      bindIdQuery(db, syncIdQueries.unread, { limit: 100_000 }),
      bindIdQuery(db, syncIdQueries.starred, { limit: 100_000 }),
      bindIdQuery(db, syncIdQueries.readSince, { otSeconds: 0, limit: 100_000 }),
      ...Object.values(FEEDS).flatMap((feedId) =>
        [syncIdQueries.feedSince, syncIdQueries.feedUnreadSince].map((query) =>
          bindIdQuery(db, query, { feedId, otSeconds: 0, limit: 100_000 }),
        ),
      ),
    ];
    const returned = (await db.batch<{ id: number }>(pages)).flatMap((r) => r.results.map((row) => row.id));
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.filter((id) => purged.has(id))).toEqual([]);
  });
});

describe("the budget", () => {
  it("caps a run at 2,000 changed rows, and the next run continues", async () => {
    // The cap falls inside the second rule's run, not between two rules.
    await seed([
      ...Array.from({ length: 1_500 }, (_, i) => item(`c-${i}`, "c", 10 + i / 100)),
      ...Array.from({ length: 1_000 }, (_, i) => item(`b-${i}`, "b", 40 + i / 100, { read: true })),
    ]);

    expect(await runMaintenance(db, config, NOW)).toEqual({ tombstoned: 2_000, deleted: 0, erred: 0 });
    expect(await runMaintenance(db, config, NOW)).toEqual({ tombstoned: 500, deleted: 0, erred: 0 });
    expect(await runMaintenance(db, config, NOW)).toEqual({ tombstoned: 0, deleted: 0, erred: 0 });
  });

  it("goes to the higher-priority rules first", async () => {
    // One of each, so a budget of n reaches exactly the first n rules.
    await seed([
      item("c-archived", "c", 1),
      item("d-beyond-max", "d", 5),
      item("d-kept-1", "d", 4),
      item("d-kept-2", "d", 3),
      item("d-kept-3", "d", 2),
      item("b-unread-old", "b", 91),
      item("b-read-old", "b", 31, { read: true }),
      item("b-pending-old", "b", 2, { status: "pending" }),
      item("b-error-old", "b", 31.5, { status: "error" }),
      item("b-tomb-old", "b", 400, { status: "purged" }),
    ]);
    const order = ["c-archived", "d-beyond-max", "b-unread-old", "b-read-old", "b-pending-old", "b-error-old", "b-tomb-old"];

    for (let n = 1; n <= order.length; n++) {
      const diff = await changes(() => runMaintenance(db, config, NOW, { ...MAINTENANCE_LIMITS, maxChanges: 1 }));
      expect(Object.keys(diff)).toEqual([order[n - 1]]);
    }
  });
});

describe("the storage guard", () => {
  const guarded = { maxChanges: 3, storageGuardBytes: 1 };

  it("tombstones the oldest unread non-starred items with the budget left, and warns", async () => {
    await seed([
      item("a-unread-oldest-starred", "a", 20, { starred: true }),
      item("b-unread-oldest", "b", 19),
      item("b-read-older", "b", 18.5, { read: true }),
      item("a-unread-2", "a", 18),
      item("b-unread-3", "b", 17),
      item("b-unread-4", "b", 16),
    ]);

    let report: unknown;
    const diff = await changes(async () => (report = await runMaintenance(db, config, NOW, guarded)));
    expect(diff).toEqual({ "b-unread-oldest": "purged", "a-unread-2": "purged", "b-unread-3": "purged" });
    expect(report).toMatchObject({ tombstoned: 3, warning: expect.stringMatching(/storage guard/) });
  });

  it("still warns when the settings' own rules used the whole budget", async () => {
    await seed([item("b-unread-old-1", "b", 100), item("b-unread-old-2", "b", 99), item("b-unread-new", "b", 1)]);

    let report: unknown;
    const diff = await changes(async () => (report = await runMaintenance(db, config, NOW, { ...guarded, maxChanges: 2 })));
    expect(diff).toEqual({ "b-unread-old-1": "purged", "b-unread-old-2": "purged" });
    expect(report).toMatchObject({ tombstoned: 2, warning: expect.stringMatching(/storage guard/) });
  });

  it("stays quiet below the threshold", async () => {
    await seed([item("b-unread-new", "b", 1)]);

    expect(await runMaintenance(db, config, NOW)).toEqual({ tombstoned: 0, deleted: 0, erred: 0 });
  });
});

interface Executed {
  name: string;
  sql: string;
  params: unknown[];
  rowsRead: number;
  changes: number;
}

const statementName = new Map(Object.entries(maintenanceSql).map(([name, sql]) => [sql, name]));

// Passes every statement through to D1 and records each maintenance statement
// with its bindings and the rows it read and changed.
function recorded(log: Executed[]): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      const name = statementName.get(sql);
      if (!name) return statement;
      return {
        bind(...params: unknown[]) {
          const bound = statement.bind(...params);
          return {
            async run() {
              const result = await bound.run();
              log.push({ name, sql, params, rowsRead: result.meta.rows_read, changes: result.meta.changes });
              return result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

// 500 days of items, two a day per live feed and one a day for the archived
// one, so every rule has rows to change and rows it must leave alone. Only
// ok items are starred: clients never see the others.
function history(): Seed[] {
  const seeds: Seed[] = [];
  for (let day = 0; day < 500; day++) {
    for (const feed of ["a", "b", "d", "e", "c"] as const) {
      for (let k = 0; k < (feed === "c" ? 1 : 2); k++) {
        const n = day * 10 + k;
        const status: Status =
          day > 380 ? "purged" : day === 1 && k === 0 ? "pending" : n % 97 === 0 ? "error" : "ok";
        seeds.push(
          item(`${feed}-${day}-${k}`, feed, day + 0.1 + k * 0.3, {
            status,
            read: (n + day) % 3 !== 0,
            starred: status === "ok" && n % 41 === 0,
          }),
        );
      }
    }
  }
  return seeds;
}

// Measured in local D1, which matched remote D1 in Phase 0 (0.12):
// - A row changed through `WHERE id IN (subquery)` costs 5 rows read (4 for a
//   delete), against 1 for a plain range update. The cap needs the LIMIT, so
//   every statement pays it; it is still proportional to the rows changed.
// - Each feed in the JSON costs up to 3 (its json_each row, the id-bound lookup
//   on item_crawled, the entry that ends its range), and each statement 2
//   more, both measured on an empty item table.
const READS_PER_UPDATE = 5;
const READS_PER_DELETE = 4;
const READS_PER_FEED = 3;
// maxItems also reads each feed's materialized bound and walks two ranges
// (is_read 0 and 1): 7 per feed, measured.
const MAX_ITEMS_READS_PER_FEED = 7;
const READS_PER_STATEMENT = 2;

const guardEverything = { maxChanges: 100_000, storageGuardBytes: 0 };

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (await db.prepare(`SELECT count(*) AS n FROM item WHERE ${sql}`).bind(...params).first<number>("n")) ?? 0;
}

describe("every maintenance statement", () => {
  let first: Executed[];
  let second: Executed[];
  // Rows a statement must read beyond its changed rows and its per-feed cost.
  let maxItemsWindow: Map<number, number>;
  let starredUnread: number;

  beforeEach(async () => {
    await seed(history());
    // The newest maxItems + 1 ok items of each feed, starred ones included,
    // which the maxItems rule counts to find its bound.
    maxItemsWindow = new Map();
    for (const [feed, maxItems] of [["a", 1000], ["b", 1000], ["e", 1000], ["d", 3]] as const) {
      const ok = await count("status = 'ok' AND feed_id = ?1", FEEDS[feed]);
      const starred = await count("status = 'ok' AND feed_id = ?1 AND is_starred = 1", FEEDS[feed]);
      maxItemsWindow.set(maxItems, (maxItemsWindow.get(maxItems) ?? 0) + Math.min(ok, maxItems + 1 + starred));
    }
    starredUnread = await count("status = 'ok' AND is_read = 0 AND is_starred = 1");

    first = [];
    await runMaintenance(recorded(first), config, NOW, guardEverything);
    second = [];
    await runMaintenance(recorded(second), config, NOW, guardEverything);
  });

  it("runs once per rule, and the first run changes rows in each", () => {
    expect(first.map((e) => e.name)).toEqual([
      "archivedOk",
      "archivedUnsettled",
      "maxItems",
      "maxItems",
      "unreadAge",
      "readAge",
      "storageGuard",
      "pendingToError",
      "errorAge",
      "purgeTombstones",
    ]);
    for (const e of first.filter((e) => !(e.name === "maxItems" && e.params[1] === 1000))) {
      expect(e.changes, e.name).toBeGreaterThan(0);
    }
    expect(second.every((e) => e.changes === 0)).toBe(true);
  });

  it("uses an index, with no scan of item and no sort", async () => {
    for (const e of first) {
      const { results } = await db
        .prepare(`EXPLAIN QUERY PLAN ${e.sql}`)
        .bind(...e.params)
        .all<{ detail: string }>();
      const details = results.map((r) => r.detail);
      expect(details.join("\n"), e.name).toMatch(/USING (COVERING )?INDEX item_(retain|unsettled|unread)/);
      for (const detail of details) {
        expect(detail, e.name).not.toMatch(/^SCAN (item|i)\b/);
        expect(detail, e.name).not.toContain("TEMP B-TREE");
      }
    }
  });

  it("reads a fixed number of rows per changed row, plus a few per feed", () => {
    // The guard has no feed list but one range across all feeds.
    const feeds = (e: Executed) => (e.name === "storageGuard" ? 1 : JSON.parse(e.params[0] as string).length);
    for (const e of [...first, ...second]) {
      const perRow = e.name === "purgeTombstones" ? READS_PER_DELETE : READS_PER_UPDATE;
      const perFeed = e.name === "maxItems" ? MAX_ITEMS_READS_PER_FEED : READS_PER_FEED;
      let allowance = perFeed * feeds(e) + READS_PER_STATEMENT;
      // The maxItems rule counts each feed's newest items to find its bound;
      // the guard reads past starred unread items, which item_unread holds.
      if (e.name === "maxItems") allowance += maxItemsWindow.get(e.params[1] as number) ?? 0;
      if (e.name === "storageGuard") allowance += starredUnread;
      expect(e.rowsRead, `${e.name}: ${e.changes} changed`).toBeGreaterThanOrEqual(perRow * e.changes);
      expect(e.rowsRead, `${e.name}: ${e.changes} changed`).toBeLessThanOrEqual(perRow * e.changes + allowance);
    }
  });
});

