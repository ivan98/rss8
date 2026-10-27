import { describe, expect, it } from "vitest";
import { dailyContent, type FeedHealth } from "../src/system-feed";

const feed = (title: string, lastFetchedAt: number | null, added: number): FeedHealth => ({
  title,
  enabled: true,
  lastFetchedAt,
  lastError: null,
  failingSince: null,
  added,
  errors: 0,
});

describe("daily report table", () => {
  it("lists the newest fetch first, then the most new items, with never-fetched feeds last", () => {
    const at = Date.UTC(2026, 9, 26, 3, 0);
    const html = dailyContent({
      timezone: "Asia/Singapore",
      feeds: [
        feed("never", null, 9),
        feed("older", at - 3_600_000, 50),
        feed("same minute, few", at + 1_000, 1),
        feed("same minute, many", at + 30_000, 7),
      ],
      library: { total: 0, unread: 0, starred: 0 },
      maintenance: { tombstoned: 0, deleted: 0, erred: 0 },
      sizeBytes: 0,
      version: null,
    });

    const titles = [...html.matchAll(/<tr><th [^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(titles).toEqual(["Feed", "same minute, many", "same minute, few", "older", "never"]);
  });

  it("uses only th cells with the attributes and styles Unread and Reeder each honour", () => {
    const html = dailyContent({
      timezone: "Asia/Singapore",
      feeds: [{ ...feed("errors", Date.UTC(2026, 9, 26, 3, 0), 4), errors: 2 }],
      library: { total: 0, unread: 0, starred: 0 },
      maintenance: { tombstoned: 0, deleted: 0, erred: 0 },
      sizeBytes: 0,
      version: null,
    });

    expect(html).toContain('<table border="1"');
    expect(html).not.toContain("<td");
    const cells = [...html.matchAll(/<th ([^>]*)>/g)].map((m) => m[1]!);
    expect(cells).toHaveLength(8);
    for (const attrs of cells) expect(attrs).toMatch(/border-right: 1px solid #888 !important/);
    expect(cells[1]).toMatch(/align="right".*width: 3em !important/);
    expect(html).toContain(">4</th>");
    expect(html).toContain("ok; 2 article errors</th>");
  });
});
