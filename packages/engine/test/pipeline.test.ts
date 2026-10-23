import { createScheduledController } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEED_BYTE_CAP } from "../src/context";
import { createWorker } from "../src/index";
import {
  captureQueue,
  db,
  deliver,
  engineEnv,
  fakeOrigin,
  feedId,
  feedSource,
  items,
  resetDb,
  rss,
  setup,
  testConfig,
} from "./fakes";

const FEED_URL = "https://example.com/feed.xml";
const OTHER_URL = "https://example.org/feed.xml";
const day = (n: number) => `${new Date(Date.UTC(2026, 0, n)).toUTCString()}`;

const plain = testConfig([{ key: "plain", source: "fake-feed", enabled: true, options: { url: FEED_URL } }]);
const withArticles = testConfig([{ key: "pages", source: "fake-article", enabled: true, options: { url: FEED_URL } }]);

function serve(body: string, headers: Record<string, string> = {}) {
  return () => new Response(body, { headers: { "content-type": "application/rss+xml", ...headers } });
}

async function feedRow(key: string) {
  return db
    .prepare("SELECT last_fetched_at, last_error, state FROM feed WHERE key = ?")
    .bind(key)
    .first<{ last_fetched_at: number | null; last_error: string | null; state: string | null }>();
}

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("discover", () => {
  it("stores a source's complete items as ok, the newest with the highest id", async () => {
    const worker = await setup(plain);
    captureQueue();
    fakeOrigin({
      [FEED_URL]: serve(
        rss([
          { guid: "b", title: "Newer", link: "https://example.com/b", pubDate: day(2), body: "Second" },
          { guid: "a", title: "Older", link: "https://example.com/a", pubDate: day(1), body: "First" },
        ]),
      ),
    });
    const before = Date.now();

    const result = await deliver(worker, { type: "discover", feedId: await feedId("plain") });

    expect(result).toEqual({ ack: true });
    const rows = await items();
    expect(rows.map((r) => [r.guid, r.status, r.title, r.summary, r.published_at])).toEqual([
      ["fake-a", "ok", "Older", "First", Date.UTC(2026, 0, 1) / 1000],
      ["fake-b", "ok", "Newer", "Second", Date.UTC(2026, 0, 2) / 1000],
    ]);
    expect((await feedRow("plain"))?.last_fetched_at).toBeGreaterThanOrEqual(before);
    expect((await feedRow("plain"))?.last_error).toBeNull();
  });

  it("inserts a guid once: repeated in one feed, on a second run, and across feeds", async () => {
    const config = testConfig([
      { key: "one", source: "fake-feed", enabled: true, options: { url: FEED_URL } },
      { key: "two", source: "fake-feed", enabled: true, options: { url: OTHER_URL } },
    ]);
    const worker = await setup(config);
    captureQueue();
    fakeOrigin({
      [FEED_URL]: serve(rss([{ guid: "x", title: "first copy" }, { guid: "x", title: "second copy" }, { guid: "y" }])),
      [OTHER_URL]: serve(rss([{ guid: "y", title: "from two" }, { guid: "z" }])),
    });

    await deliver(worker, { type: "discover", feedId: await feedId("one") });
    const afterFirst = await items();
    await deliver(worker, { type: "discover", feedId: await feedId("one") });
    await deliver(worker, { type: "discover", feedId: await feedId("two") });

    const rows = await items();
    expect(rows.slice(0, afterFirst.length)).toEqual(afterFirst);
    expect(rows.map((r) => [r.guid, r.feed_id, r.title])).toEqual([
      ["fake-y", await feedId("one"), null],
      ["fake-x", await feedId("one"), "first copy"],
      ["fake-z", await feedId("two"), null],
    ]);
  });

  it("never lets crawled_at decrease as id grows, even when the clock is behind", async () => {
    const worker = await setup(plain);
    captureQueue();
    const ahead = Date.now() + 3_600_000;
    await db
      .prepare("INSERT INTO item (feed_id, guid, status, crawled_at) VALUES (?, 'fake-earlier', 'ok', ?)")
      .bind(await feedId("plain"), ahead)
      .run();
    fakeOrigin({ [FEED_URL]: serve(rss([{ guid: "late-1" }, { guid: "late-2" }])) });

    await deliver(worker, { type: "discover", feedId: await feedId("plain") });

    const rows = await items();
    expect(rows.map((r) => r.guid)).toEqual(["fake-earlier", "fake-late-2", "fake-late-1"]);
    expect(rows.map((r) => r.crawled_at)).toEqual([ahead, ahead, ahead]);
  });

  it("keeps the newest 100 of an oldest-first feed of 150", async () => {
    const worker = await setup(plain);
    captureQueue();
    const entries = Array.from({ length: 150 }, (_, i) => ({ guid: `n${i + 1}`, pubDate: day(i + 1) }));
    fakeOrigin({ [FEED_URL]: serve(rss(entries)) });

    await deliver(worker, { type: "discover", feedId: await feedId("plain") });

    const guids = (await items()).map((r) => r.guid);
    expect(guids).toEqual(Array.from({ length: 100 }, (_, i) => `fake-n${i + 51}`));
  });

  it("keeps undated items in document order behind dated ones", async () => {
    const worker = await setup(plain);
    captureQueue();
    const entries = [
      { guid: "u1" },
      { guid: "d1", pubDate: day(1) },
      { guid: "u2" },
      { guid: "d2", pubDate: day(2) },
      ...Array.from({ length: 99 }, (_, i) => ({ guid: `u${i + 3}` })),
    ];
    fakeOrigin({ [FEED_URL]: serve(rss(entries)) });

    await deliver(worker, { type: "discover", feedId: await feedId("plain") });

    const newestFirst = (await items()).map((r) => r.guid).reverse();
    expect(newestFirst.slice(0, 4)).toEqual(["fake-d2", "fake-d1", "fake-u1", "fake-u2"]);
    expect(newestFirst).toHaveLength(100);
    expect(newestFirst.at(-1)).toBe("fake-u98");
  });

  it("parses the prefix of a body over the byte cap, drops the cut item and warns on the feed", async () => {
    const worker = await setup(plain);
    captureQueue();
    const padding = "x".repeat(100 * 1024);
    const body = rss(Array.from({ length: 50 }, (_, i) => ({ guid: `big${i}`, pubDate: day(50 - i), body: padding })));
    const prefix = body.slice(0, FEED_BYTE_CAP);
    const complete = prefix.split("</item>").length - 1;
    expect(body.length).toBeGreaterThan(FEED_BYTE_CAP);
    expect(complete).toBeGreaterThan(0);
    expect(complete).toBeLessThan(50);
    fakeOrigin({ [FEED_URL]: serve(body) });

    await deliver(worker, { type: "discover", feedId: await feedId("plain") });

    const rows = await items();
    expect(rows.map((r) => r.guid).sort()).toEqual(
      Array.from({ length: complete }, (_, i) => `fake-big${i}`).sort(),
    );
    expect(rows.every((r) => r.summary === padding)).toBe(true);
    expect((await feedRow("plain"))?.last_error).toMatch(/^warning: .*feed\.xml is over 4 MB/);
  });

  it("clears the warning when a later run reads the whole body", async () => {
    const worker = await setup(plain);
    captureQueue();
    await db.prepare("UPDATE feed SET last_error = 'warning: old' WHERE key = 'plain'").run();
    fakeOrigin({ [FEED_URL]: serve(rss([{ guid: "small" }])) });

    await deliver(worker, { type: "discover", feedId: await feedId("plain") });

    expect((await feedRow("plain"))?.last_error).toBeNull();
  });

  it("sends stored validators, accepts a 304 and keeps them", async () => {
    const worker = await setup(plain);
    captureQueue();
    const lastModified = "Mon, 19 Oct 2026 00:00:00 GMT";
    let notModified = false;
    const requests = fakeOrigin({
      [FEED_URL]: (req) =>
        notModified && req.headers.get("if-modified-since") === lastModified
          ? new Response(null, { status: 304 })
          : new Response(rss([{ guid: "v1" }]), { headers: { etag: 'W/"1"', "last-modified": lastModified } }),
    });
    const id = await feedId("plain");

    await deliver(worker, { type: "discover", feedId: id });
    const stored = await db.prepare("SELECT url, feed_id, etag, last_modified FROM feed_url").all();
    expect(stored.results).toEqual([{ url: FEED_URL, feed_id: id, etag: 'W/"1"', last_modified: lastModified }]);
    expect(requests[0]?.headers["if-none-match"]).toBeUndefined();

    notModified = true;
    const fetchedBefore = (await feedRow("plain"))?.last_fetched_at ?? 0;
    const itemsBefore = await items();
    const result = await deliver(worker, { type: "discover", feedId: id });

    expect(result).toEqual({ ack: true });
    expect(requests[1]?.headers).toMatchObject({ "if-none-match": 'W/"1"', "if-modified-since": lastModified });
    expect(await items()).toEqual(itemsBefore);
    expect((await db.prepare("SELECT url, feed_id, etag, last_modified FROM feed_url").all()).results).toEqual(
      stored.results,
    );
    expect((await feedRow("plain"))?.last_fetched_at).toBeGreaterThanOrEqual(fetchedBefore);
  });

  it("stores no validators or state when the run fails after a 200, so the retry gets a 200", async () => {
    const worker = await setup(plain);
    captureQueue();
    let calls = 0;
    const requests = fakeOrigin({
      [FEED_URL]: () =>
        new Response(rss([{ guid: "ok" }]), { headers: { etag: `"e${++calls}"` } }),
    });
    const id = await feedId("plain");
    const discover = vi.spyOn(feedSource, "discover").mockImplementationOnce(async (_feed, ctx) => {
      await ctx.fetchFeed(FEED_URL);
      ctx.state.set({ cursor: 1 });
      throw new Error("source broke after the fetch");
    });

    const first = await deliver(worker, { type: "discover", feedId: id });
    expect(first).toEqual({ retryDelaySeconds: 600 });
    expect((await db.prepare("SELECT count(*) AS n FROM feed_url").first("n"))).toBe(0);
    expect((await feedRow("plain"))?.state).toBeNull();

    discover.mockRestore();
    await deliver(worker, { type: "discover", feedId: id }, 2);
    expect(requests[1]?.headers["if-none-match"]).toBeUndefined();
    expect((await items()).map((r) => r.guid)).toEqual(["fake-ok"]);
  });

  it("does nothing for a disabled feed", async () => {
    const worker = await setup(testConfig([{ ...plain.feeds[0]!, enabled: false }]));
    captureQueue();
    const requests = fakeOrigin({ [FEED_URL]: serve(rss([{ guid: "a" }])) });

    await deliver(worker, { type: "discover", feedId: await feedId("plain") });

    expect(requests).toEqual([]);
    expect(await items()).toEqual([]);
  });

  it("records the error on the feed only after the last attempt", async () => {
    const worker = await setup(plain);
    captureQueue();
    fakeOrigin({ [FEED_URL]: () => new Response("down", { status: 503 }) });
    const id = await feedId("plain");

    for (const attempt of [1, 2, 3]) {
      const result = await deliver(worker, { type: "discover", feedId: id }, attempt);
      expect(result).toEqual({ retryDelaySeconds: 600 });
      expect((await feedRow("plain"))?.last_error).toBeNull();
    }
    const last = await deliver(worker, { type: "discover", feedId: id }, 4);

    expect(last).toEqual({ ack: true });
    expect((await feedRow("plain"))?.last_error).toBe(
      `discover failed after 4 attempts: GET ${FEED_URL}: HTTP 503`,
    );
  });
});

describe("articles", () => {
  const pages = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ guid: `p${i}`, link: `https://example.com/p${i}`, pubDate: day(10 - i) }));

  it("enqueues one staggered article message per inserted row, and none for known rows", async () => {
    const worker = await setup(withArticles);
    const sent = captureQueue();
    fakeOrigin({ [FEED_URL]: serve(rss(pages(3))) });

    await deliver(worker, { type: "discover", feedId: await feedId("pages") });

    const rows = await items();
    expect(rows.map((r) => [r.guid, r.status])).toEqual([
      ["fake-p2", "pending"],
      ["fake-p1", "pending"],
      ["fake-p0", "pending"],
    ]);
    expect(sent).toEqual(
      rows.map((r, i) => ({ body: { type: "article", itemId: r.id }, delaySeconds: i * 2 })),
    );

    await deliver(worker, { type: "discover", feedId: await feedId("pages") });
    expect(sent).toHaveLength(3);
  });

  it("stores the fetched article as ok and counts the attempt", async () => {
    const worker = await setup(withArticles);
    const sent = captureQueue();
    fakeOrigin({
      [FEED_URL]: serve(rss(pages(1))),
      "https://example.com/p0": () => new Response("<p>Article body</p>"),
    });
    await deliver(worker, { type: "discover", feedId: await feedId("pages") });

    const result = await deliver(worker, sent[0]!.body);

    expect(result).toEqual({ ack: true });
    expect((await items()).map((r) => [r.status, r.attempts, r.content, r.url])).toEqual([
      ["ok", 1, "<p>Article body</p>", "https://example.com/p0"],
    ]);
  });

  it("treats a repeated article message as a no-op", async () => {
    const worker = await setup(withArticles);
    const sent = captureQueue();
    let articleFetches = 0;
    fakeOrigin({
      [FEED_URL]: serve(rss(pages(1))),
      "https://example.com/p0": () => new Response(`<p>version ${++articleFetches}</p>`),
    });
    await deliver(worker, { type: "discover", feedId: await feedId("pages") });
    await deliver(worker, sent[0]!.body);
    const afterFirst = await items();

    const again = await deliver(worker, sent[0]!.body);

    expect(again).toEqual({ ack: true });
    expect(articleFetches).toBe(1);
    expect(await items()).toEqual(afterFirst);
  });

  it("retries a failing article and marks it error after the last attempt", async () => {
    const worker = await setup(withArticles);
    const sent = captureQueue();
    fakeOrigin({
      [FEED_URL]: serve(rss(pages(1))),
      "https://example.com/p0": () => new Response("gone", { status: 500 }),
    });
    await deliver(worker, { type: "discover", feedId: await feedId("pages") });
    const message = sent[0]!.body;

    for (const attempt of [1, 2, 3]) {
      const result = await deliver(worker, message, attempt);
      expect(result).toEqual({ retryDelaySeconds: 600 });
      expect((await items())[0]).toMatchObject({ status: "pending", attempts: attempt });
    }
    const last = await deliver(worker, message, 4);

    expect(last).toEqual({ ack: true });
    expect((await items())[0]).toMatchObject({ status: "error", attempts: 4, content: null });

    const late = await deliver(worker, message, 4);
    expect(late).toEqual({ ack: true });
    expect((await items())[0]).toMatchObject({ status: "error", attempts: 4 });
  });
});

describe("cron dispatcher", () => {
  const config = testConfig([
    { key: "hourly", source: "fake-feed", enabled: true, options: { url: FEED_URL } },
    { key: "odd", source: "fake-feed", enabled: true, options: { url: OTHER_URL }, schedule: ["7 9 * * *"] },
    { key: "off", source: "fake-feed", enabled: false, options: { url: FEED_URL } },
  ]);
  const at15and25 = testConfig([
    { key: "at15", source: "fake-feed", enabled: true, options: { url: FEED_URL }, schedule: ["15 * * * *"] },
    { key: "at25", source: "fake-feed", enabled: true, options: { url: OTHER_URL }, schedule: ["25 * * * *"] },
  ]);

  function controllerAt(iso: string) {
    return createScheduledController({ scheduledTime: Date.parse(iso) });
  }

  async function tick(iso: string, tickConfig = config) {
    const worker = await setup(tickConfig);
    const sent = captureQueue();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.scheduled(controllerAt(iso), engineEnv);
    const maintenanceRuns = log.mock.calls.filter((c) => c[0] === "maintenance").length;
    vi.restoreAllMocks();
    return { sent, maintenanceRuns };
  }

  async function enqueuedKeys(iso: string, tickConfig = at15and25): Promise<string[]> {
    const { sent } = await tick(iso, tickConfig);
    const ids = sent.map((m) => (m.body as { feedId: number }).feedId);
    const keys = [];
    for (const f of tickConfig.feeds) if (ids.includes(await feedId(f.key))) keys.push(f.key);
    return keys;
  }

  async function metaValue(key: string) {
    return db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<string>("value");
  }

  it("enqueues discover for feeds due on the tick, by their schedule in the config time zone", async () => {
    // 01:00 UTC is 09:00 SGT: the hourly default is due, 09:07 is not yet.
    expect((await tick("2026-10-25T01:00:00Z")).sent).toEqual([
      { body: { type: "discover", feedId: await feedId("hourly") } },
    ]);
    // 01:15 UTC covers 09:01-09:15 SGT.
    expect((await tick("2026-10-25T01:15:00Z")).sent).toEqual([
      { body: { type: "discover", feedId: await feedId("odd") } },
    ]);
    expect((await tick("2026-10-25T01:30:00Z")).sent).toEqual([]);
  });

  it("never enqueues a disabled or archived feed", async () => {
    await setup(config);
    await db.prepare("UPDATE feed SET archived_at = 1 WHERE key = 'hourly'").run();
    const worker = await setup(testConfig(config.feeds.filter((f) => f.key !== "hourly")));
    const sent = captureQueue();
    await worker.scheduled(controllerAt("2026-10-25T01:00:00Z"), engineEnv);
    expect(sent).toEqual([]);
  });

  it("covers only the last 15 minutes on the first tick ever and records the tick", async () => {
    expect(await enqueuedKeys("2026-10-25T08:30:00Z")).toEqual(["at25"]);
    expect(await metaValue("last_tick")).toBe(String(Date.parse("2026-10-25T08:30:00Z")));
  });

  it("catches up a skipped tick on the next one", async () => {
    expect(await enqueuedKeys("2026-10-25T08:00:00Z")).toEqual([]);
    expect(await enqueuedKeys("2026-10-25T08:30:00Z")).toEqual(["at15", "at25"]);
  });

  it("treats a late tick like an on-time one and the next tick resumes after it", async () => {
    await enqueuedKeys("2026-10-25T08:00:00Z");
    expect(await enqueuedKeys("2026-10-25T08:23:36Z")).toEqual(["at15"]);
    expect(await enqueuedKeys("2026-10-25T08:30:00Z")).toEqual(["at25"]);
  });

  it("ignores a tick older than the last one, maintenance included", async () => {
    expect((await tick("2026-10-25T21:15:00Z", at15and25)).maintenanceRuns).toBe(1);
    // 16:15 SGT on the previous local day: a feed and maintenance would be due if it counted.
    expect(await tick("2026-10-25T08:15:00Z", at15and25)).toEqual({ sent: [], maintenanceRuns: 0 });
    expect(await metaValue("last_tick")).toBe(String(Date.parse("2026-10-25T21:15:00Z")));
    expect(await metaValue("maintenance_date")).toBe("2026-10-26");
  });

  it("never moves last_tick back when an older tick finishes after a newer one", async () => {
    const worker = await setup(at15and25);
    const sent = captureQueue();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(engineEnv.QUEUE, "sendBatch").mockImplementationOnce(async (messages) => {
      await held;
      sent.push(...messages);
      return {} as QueueSendBatchResponse;
    });

    const older = worker.scheduled(controllerAt("2026-10-25T08:15:00Z"), engineEnv);
    await vi.waitFor(() => expect(engineEnv.QUEUE.sendBatch).toHaveBeenCalledTimes(1));
    await worker.scheduled(controllerAt("2026-10-25T08:30:00Z"), engineEnv);
    release();
    await older;

    expect(await metaValue("last_tick")).toBe(String(Date.parse("2026-10-25T08:30:00Z")));
  });

  it("covers only the last 24 hours after a longer outage", async () => {
    const outage = testConfig([
      // Friday 12:00 SGT is two days before the tick; Sunday 12:00 SGT is the same day.
      { key: "friday", source: "fake-feed", enabled: true, options: { url: FEED_URL }, schedule: ["0 12 * * 5"] },
      { key: "sunday", source: "fake-feed", enabled: true, options: { url: OTHER_URL }, schedule: ["0 12 * * 0"] },
    ]);
    const tickAt = "2026-10-25T08:30:00Z";
    await setup(outage);
    await db
      .prepare("INSERT INTO meta (key, value) VALUES ('last_tick', ?)")
      .bind(String(Date.parse(tickAt) - 72 * 3_600_000))
      .run();

    expect(await enqueuedKeys(tickAt, outage)).toEqual(["sunday"]);
  });

  it("keeps last_tick when sending fails, so the next tick covers the window again", async () => {
    await enqueuedKeys("2026-10-25T08:00:00Z");
    const worker = await setup(at15and25);
    captureQueue();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(engineEnv.QUEUE, "sendBatch").mockRejectedValueOnce(new Error("queue down"));

    await expect(worker.scheduled(controllerAt("2026-10-25T08:15:00Z"), engineEnv)).rejects.toThrow("queue down");
    vi.restoreAllMocks();

    expect(await metaValue("last_tick")).toBe(String(Date.parse("2026-10-25T08:00:00Z")));
    expect(await enqueuedKeys("2026-10-25T08:30:00Z")).toEqual(["at15", "at25"]);
  });

  describe("maintenance", () => {
    // 05:15 SGT is 21:15 UTC the day before.
    it("runs on the first tick at or after 05:15 local time and records the local date", async () => {
      expect((await tick("2026-10-25T21:00:00Z")).maintenanceRuns).toBe(0);
      expect((await tick("2026-10-25T21:15:00Z")).maintenanceRuns).toBe(1);
      expect(await metaValue("maintenance_date")).toBe("2026-10-26");
    });

    it("runs on the next tick when the 05:15 tick is skipped", async () => {
      expect((await tick("2026-10-25T21:00:00Z")).maintenanceRuns).toBe(0);
      expect((await tick("2026-10-25T21:30:00Z")).maintenanceRuns).toBe(1);
    });

    it("runs once per local day", async () => {
      expect((await tick("2026-10-25T21:15:00Z")).maintenanceRuns).toBe(1);
      expect((await tick("2026-10-25T21:30:00Z")).maintenanceRuns).toBe(0);
      expect((await tick("2026-10-26T15:45:00Z")).maintenanceRuns).toBe(0);
      // 00:00 SGT is a new local day, but before 05:15.
      expect((await tick("2026-10-26T16:00:00Z")).maintenanceRuns).toBe(0);
      expect((await tick("2026-10-26T21:15:00Z")).maintenanceRuns).toBe(1);
      expect(await metaValue("maintenance_date")).toBe("2026-10-27");
    });

    it("retries on the next tick when it throws", async () => {
      const worker = await setup(config);
      captureQueue();
      const prepare = db.prepare.bind(db);
      vi.spyOn(engineEnv.DB, "prepare").mockImplementation((sql) => {
        if (sql.startsWith("SELECT id, key, archived_at FROM feed")) throw new Error("maintenance broke");
        return prepare(sql);
      });

      await expect(worker.scheduled(controllerAt("2026-10-25T21:15:00Z"), engineEnv)).rejects.toThrow(
        "maintenance broke",
      );
      vi.restoreAllMocks();

      expect(await metaValue("maintenance_date")).toBeNull();
      expect(await metaValue("last_tick")).toBe(String(Date.parse("2026-10-25T21:15:00Z")));
      expect((await tick("2026-10-25T21:30:00Z")).maintenanceRuns).toBe(1);
    });
  });
});

describe("createWorker", () => {
  it("rejects a feed whose source kind is not registered", async () => {
    expect(() => createWorker({ sources: [], config: plain })).toThrow(/unknown source "fake-feed"/);
  });

  it("rejects a bad schedule or bad options when the deployment loads", async () => {
    expect(() =>
      createWorker({ sources: [feedSource], config: testConfig([{ ...plain.feeds[0]!, schedule: ["61 * * * *"] }]) }),
    ).toThrow(/Cron "61/);
    expect(() =>
      createWorker({ sources: [feedSource], config: testConfig([{ ...plain.feeds[0]!, options: {} }]) }),
    ).toThrow(/options.url/);
  });
});
