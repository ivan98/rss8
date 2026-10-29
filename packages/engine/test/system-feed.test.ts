import { describe, expect, it } from "vitest";
import { dailyContent, type DailyReport, type FeedHealth } from "../src/system-feed";

const now = Date.UTC(2026, 9, 26, 3, 0);
const MIN = 60_000;
const DAY = 86_400_000;

const feed = (title: string, lastNewAt: number | null, added: number, lastFetchedAt: number | null = now): FeedHealth => ({
  title,
  enabled: true,
  lastFetchedAt,
  lastNewAt,
  lastError: null,
  failingSince: null,
  added,
  errors: 0,
});

const report = (feeds: FeedHealth[]): DailyReport => ({
  now,
  timezone: "Asia/Singapore",
  feeds,
  library: { total: 0, unread: 0, starred: 0 },
  maintenance: { tombstoned: 0, deleted: 0, erred: 0 },
  sizeBytes: 0,
  version: null,
});

const rowsOf = (html: string) =>
  [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((r) => [...r[1]!.matchAll(/<th [^>]*>(.*?)<\/th>/g)].map((c) => c[1]));

describe("daily report table", () => {
  it("lists the newest article first, then the most new items, with feeds without articles last", () => {
    const html = dailyContent(
      report([
        feed("none", null, 9),
        feed("stopped", now - 40 * DAY, 0),
        feed("same time, few", now - 5 * MIN, 1),
        feed("same time, many", now - 5 * MIN, 7),
      ]),
    );

    expect(rowsOf(html).map((r) => r[0])).toEqual(["Feed", "same time, many", "same time, few", "stopped", "none"]);
  });

  it("shows last new and last discover as ages", () => {
    const html = dailyContent(
      report([
        feed("fresh", now - 40 * MIN, 3, now - 5 * MIN),
        feed("quiet", now - 6 * 3_600_000, 0, now - 90 * MIN),
        feed("stopped", now - 12 * DAY, 0, null),
        feed("empty", null, 0),
      ]),
    );

    expect(rowsOf(html)).toEqual([
      ["Feed", "New", "Last new", "Last discover", "Last discover status"],
      ["fresh", "3", "40 min", "5 min", "ok"],
      ["quiet", "0", "6 h", "2 h", "ok"],
      ["stopped", "0", "12 d", "never", "ok"],
      ["empty", "0", "none", "0 min", "ok"],
    ]);
  });

  it("uses only th cells with the attributes and styles Unread and Reeder each honour", () => {
    const html = dailyContent(report([{ ...feed("errors", now - MIN, 4), errors: 2 }]));

    expect(html).toContain('<table border="1"');
    expect(html).not.toContain("<td");
    const cells = [...html.matchAll(/<th ([^>]*)>/g)].map((m) => m[1]!);
    expect(cells).toHaveLength(10);
    for (const attrs of cells) expect(attrs).toMatch(/border-right: 1px solid #888 !important/);
    expect(cells[1]).toMatch(/align="right".*width: 3em !important/);
    expect(rowsOf(html)[1]).toEqual(["errors", "4", "1 min", "0 min", "ok; 2 article errors"]);
  });
});
