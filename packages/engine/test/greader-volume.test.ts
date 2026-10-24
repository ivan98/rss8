// The sync calls Reeder and Unread make, at 9,000 retained items (design §11
// step 5), with D1 rows read taken from the API's own log lines. CPU can't be
// measured here, only on a deployed Worker.

import { afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import seedSql from "./bench/seed-9000.sql?raw";
import { db } from "./fakes";
import { Client, READ, READING_LIST, STARRED } from "./greader-client";

interface LogLine {
  route: string;
  status: number;
  count: number | null;
  rowsRead: number;
}

const DAY_S = 86_400;
const n: [string, string] = ["n", "100000"];

beforeAll(async () => {
  await db.batch([db.prepare("DELETE FROM item"), db.prepare("DELETE FROM feed_url"), db.prepare("DELETE FROM feed")]);
  const results = await db.batch(
    seedSql
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
  // Index entries count as rows written: plan the seed against the daily allowance.
  expect(results.reduce((sum, r) => sum + r.meta.rows_written, 0)).toBe(SEED_ROWS_WRITTEN);
});

const SEED_ROWS_WRITTEN = 55_508;

let log: MockInstance<typeof console.log> | undefined;
function capture(): () => LogLine[] {
  const spy = vi.spyOn(console, "log");
  log = spy;
  return () => spy.mock.calls.filter((c) => c[0] === "api").map((c) => JSON.parse(c[1] as string) as LogLine);
}
afterEach(() => log?.mockRestore());

const otSeconds = () => String(Math.floor(Date.now() / 1000) - 30 * DAY_S);

describe("at 9,000 items", () => {
  it("Unread's sync reads about one row per returned id", async () => {
    const client = await Client.login();
    const lines = capture();
    await client.get("subscription/list", [["output", "json"]]);
    await client.get("tag/list", [["types", "1"], ["output", "json"]]);
    const all = await client.ids([n, ["s", READING_LIST], ["ot", otSeconds()]]);
    const unread = await client.ids([n, ["s", READING_LIST], ["xt", READ]]);
    const starred = await client.ids([n, ["s", STARRED]]);

    // The 30-day window starts a moment after the oldest seeded item.
    expect(all.ids.length).toBeGreaterThanOrEqual(8_999);
    expect(unread.ids).toHaveLength(1_500);
    expect(starred.ids).toHaveLength(53);
    expect(lines().map((l) => [l.route, l.count, l.rowsRead])).toEqual([
      ["subscription/list", 4, 4],
      // The feeds, for their folders.
      ["tag/list", null, 4],
      // The ot lookup, plus one entry past the range unless it runs to the first item.
      ["stream/items/ids", all.ids.length, all.ids.length + 1 + (all.ids.length < 9_000 ? 1 : 0)],
      ["stream/items/ids", 1_500, 1_500],
      ["stream/items/ids", 53, 53],
    ]);
  });

  it("Reeder's sync reads about one row per returned id", async () => {
    const client = await Client.login();
    const lines = capture();
    await client.get("subscription/list", [["output", "json"]]);
    await client.ids([["n", "10000"], ["s", READING_LIST], ["xt", READ]]);
    await client.ids([["n", "10000"], ["s", STARRED]]);
    const read = await client.ids([["n", "10000"], ["s", READ], ["ot", otSeconds()]]);

    expect(read.ids.length).toBeGreaterThanOrEqual(7_499);
    expect(lines().map((l) => [l.count, l.rowsRead])).toEqual([
      [4, 4],
      [1_500, 1_500],
      [53, 53],
      [read.ids.length, read.ids.length + 2],
    ]);
  });

  it("streams all 9,000 items in one contents call, reading two rows per item", async () => {
    const client = await Client.login();
    const lines = capture();
    const ids = Array.from({ length: 9_000 }, (_, i) => String(i + 1));
    const items = await client.contents(ids);

    expect(items).toHaveLength(9_000);
    expect(items[0]!.summary.content.length).toBeGreaterThan(5_000);
    // The feeds once, then a json_each entry and an item per id.
    expect(lines().map((l) => [l.route, l.count, l.rowsRead])).toEqual([["stream/items/contents", 9_000, 4 + 2 * 9_000]]);
  });

  it("counts unread items reading one row per unread item", async () => {
    const client = await Client.login();
    const lines = capture();
    const body = await (await client.get("unread-count")).json<{ max: number }>();
    expect(body.max).toBe(1_500);
    // The unread set and its end, the feeds for their folders, then one
    // json_each entry and one item per feed.
    expect(lines().map((l) => l.rowsRead)).toEqual([1_500 + 1 + 4 + 2 * 4]);
  });

  it("reads a folder's id sets at about one row per returned id", async () => {
    await db.prepare("UPDATE feed SET category = 'News' WHERE id <= 2").run();
    try {
      const client = await Client.login();
      const lines = capture();
      const unread = await client.ids([n, ["s", "user/-/label/News"], ["xt", READ]]);
      const all = await client.ids([n, ["s", "user/-/label/News"]]);

      expect(unread.ids).toHaveLength(750);
      expect(all.ids).toHaveLength(4_500);
      // The feeds to find the folder's, then per feed the ot lookup, its ids
      // and one entry past its range (none for feed 1, whose range starts the index).
      expect(lines().map((l) => [l.count, l.rowsRead])).toEqual([
        [750, 4 + 750 + 3],
        [4_500, 4 + 4_500 + 3],
      ]);
    } finally {
      await db.prepare("UPDATE feed SET category = NULL").run();
    }
  });
});
