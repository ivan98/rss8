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
  systemFeed,
  systemMessages,
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

  it("records each failed attempt on the feed, and the final error after the last", async () => {
    const worker = await setup(plain);
    captureQueue();
    fakeOrigin({ [FEED_URL]: () => new Response("down", { status: 503 }) });
    const id = await feedId("plain");

    for (const attempt of [1, 2, 3]) {
      const result = await deliver(worker, { type: "discover", feedId: id }, attempt);
      expect(result).toEqual({ retryDelaySeconds: 600 });
      expect((await feedRow("plain"))?.last_error).toBe(
        `discover attempt ${attempt} of 4 failed, retrying in 10 min: GET ${FEED_URL}: HTTP 503`,
      );
    }
    const last = await deliver(worker, { type: "discover", feedId: id }, 4);

    expect(last).toEqual({ ack: true });
    expect((await feedRow("plain"))?.last_error).toBe(
      `discover failed after 4 attempts: GET ${FEED_URL}: HTTP 503`,
    );
  });

  it("doesn't retry a feed that answers 403, and a later success clears the error", async () => {
    const worker = await setup(plain);
    captureQueue();
    let status = 403;
    fakeOrigin({ [FEED_URL]: () => (status === 403 ? new Response("blocked", { status }) : serve(rss([{ guid: "a" }]))()) });
    const id = await feedId("plain");

    expect(await deliver(worker, { type: "discover", feedId: id })).toEqual({ ack: true });
    expect((await feedRow("plain"))?.last_error).toBe(`discover failed, not retried: GET ${FEED_URL}: HTTP 403`);

    status = 200;
    expect(await deliver(worker, { type: "discover", feedId: id })).toEqual({ ack: true });
    expect((await feedRow("plain"))?.last_error).toBeNull();
    expect((await items()).filter((r) => r.guid.startsWith("fake-"))).toHaveLength(1);
  });
});

describe("system feed", () => {
  const titles = async () => (await systemMessages()).map((m) => m.title);

  it("posts once when a feed starts failing and once when it recovers, however often it fails", async () => {
    const worker = await setup(plain);
    captureQueue();
    let status = 403;
    fakeOrigin({ [FEED_URL]: () => (status === 200 ? serve(rss([{ guid: "a" }]))() : new Response("x", { status })) });
    const id = await feedId("plain");

    await deliver(worker, { type: "discover", feedId: id });
    await deliver(worker, { type: "discover", feedId: id });
    status = 503;
    await deliver(worker, { type: "discover", feedId: id }, 4);
    expect(await titles()).toEqual(["plain is failing"]);
    expect((await systemMessages())[0]!.content).toContain(`GET ${FEED_URL}: HTTP 403`);

    status = 200;
    await deliver(worker, { type: "discover", feedId: id });
    await deliver(worker, { type: "discover", feedId: id });
    expect(await titles()).toEqual(["plain is failing", "plain recovered"]);
  });

  // Makes the next system message insert throw, as a transient D1 error would.
  function failNextSystemPost() {
    const prepare = db.prepare.bind(db);
    let failed = false;
    vi.spyOn(engineEnv.DB, "prepare").mockImplementation((sql) => {
      if (!failed && sql.includes("SELECT id, ?1, 'ok'")) {
        failed = true;
        throw new Error("D1 hiccup");
      }
      return prepare(sql);
    });
  }

  it("still acks a final failure whose message can't be posted, and posts it on the next failure", async () => {
    const worker = await setup(plain);
    captureQueue();
    fakeOrigin({ [FEED_URL]: () => new Response("x", { status: 403 }) });
    const id = await feedId("plain");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    failNextSystemPost();
    expect(await deliver(worker, { type: "discover", feedId: id })).toEqual({ ack: true });
    expect(await systemMessages()).toEqual([]);
    expect(error.mock.calls.some(([line]) => String(line).includes("feed-failing not posted"))).toBe(true);

    await deliver(worker, { type: "discover", feedId: id });
    await deliver(worker, { type: "discover", feedId: id });
    expect(await titles()).toEqual(["plain is failing"]);
  });

  it("stores a recovering feed's items, validators and recovered message together, or none of them", async () => {
    const worker = await setup(withArticles);
    const sent = captureQueue();
    let status = 403;
    fakeOrigin({
      [FEED_URL]: () =>
        status === 200 ? serve(rss([{ guid: "a" }]), { etag: '"v1"' })() : new Response("x", { status }),
    });
    const id = await feedId("pages");
    await deliver(worker, { type: "discover", feedId: id });
    status = 200;

    // Fails the recovered insert when it runs inside the batch, as a D1 error would.
    await db.exec(
      "CREATE TRIGGER fail_recovered BEFORE INSERT ON item WHEN NEW.guid LIKE 'system:feed-recovered:%' BEGIN SELECT RAISE(ABORT, 'D1 hiccup'); END",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await deliver(worker, { type: "discover", feedId: id })).toEqual({ retryDelaySeconds: 600 });
    expect((await items()).filter((r) => r.guid.startsWith("fake-"))).toEqual([]);
    expect((await db.prepare("SELECT count(*) AS n FROM feed_url").first<number>("n"))).toBe(0);
    expect(await titles()).toEqual(["pages is failing"]);

    await db.exec("DROP TRIGGER fail_recovered");
    expect(await deliver(worker, { type: "discover", feedId: id }, 2)).toEqual({ ack: true });
    expect((await items()).filter((r) => r.guid.startsWith("fake-"))).toHaveLength(1);
    expect(sent.filter((m) => m.body.type === "article")).toHaveLength(1);
    expect(await titles()).toEqual(["pages is failing", "pages recovered"]);
  });

  it("acks maintenance whose daily report fails, without rerunning retention", async () => {
    const worker = await setup(plain);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(engineEnv.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("count(*) AS total")) throw new Error("report broke");
      return prepare(sql);
    });

    expect(await deliver(worker, { type: "maintenance", date: "2026-10-26", now: Date.now() })).toEqual({ ack: true });
    expect(await systemMessages()).toEqual([]);
    expect(error.mock.calls.some(([line]) => String(line).includes("daily report not posted"))).toBe(true);
  });

  it("posts nothing for a failure that a retry fixes", async () => {
    const worker = await setup(plain);
    captureQueue();
    let status = 503;
    fakeOrigin({ [FEED_URL]: () => (status === 200 ? serve(rss([{ guid: "a" }]))() : new Response("x", { status })) });
    const id = await feedId("plain");

    expect(await deliver(worker, { type: "discover", feedId: id })).toEqual({ retryDelaySeconds: 600 });
    status = 200;
    expect(await deliver(worker, { type: "discover", feedId: id }, 2)).toEqual({ ack: true });

    expect(await systemMessages()).toEqual([]);
  });

  it("posts nothing while the system feed is disabled", async () => {
    const worker = await setup(testConfig([...plain.feeds.filter((f) => f.key !== "system"), { ...systemFeed, enabled: false }]));
    captureQueue();
    fakeOrigin({ [FEED_URL]: () => new Response("x", { status: 403 }) });

    await deliver(worker, { type: "discover", feedId: await feedId("plain") });

    expect((await feedRow("plain"))?.last_error).toMatch(/HTTP 403/);
    expect(await systemMessages()).toEqual([]);
  });

  it("posts one daily report per maintenance date, listing each feed's new items and status", async () => {
    const worker = await setup(plain);
    captureQueue();
    fakeOrigin({ [FEED_URL]: serve(rss([{ guid: "a" }, { guid: "b" }])) });
    await deliver(worker, { type: "discover", feedId: await feedId("plain") });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const message = { type: "maintenance", date: "2026-10-26", now: Date.now() } as const;
    await deliver(worker, message);
    await deliver(worker, message);

    const reports = await systemMessages();
    expect(reports.map((m) => m.title)).toEqual(["rss8 daily: all 1 feeds healthy"]);
    expect(reports[0]!.content).toMatch(/<tr><td [^>]*>plain<\/td><td [^>]*>2<\/td>/);
    expect(reports[0]!.content).toContain("2 articles kept (2 unread, 0 starred); 2 new in 24 hours");

    // The second report must not count the first one.
    await deliver(worker, { ...message, date: "2026-10-27" });
    expect((await systemMessages()).at(-1)!.content).toContain("2 articles kept (2 unread, 0 starred)");
  });

  it("names the feeds that need attention in the daily report's title", async () => {
    const worker = await setup(plain);
    captureQueue();
    fakeOrigin({ [FEED_URL]: () => new Response("x", { status: 403 }) });
    await deliver(worker, { type: "discover", feedId: await feedId("plain") });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await deliver(worker, { type: "maintenance", date: "2026-10-26", now: Date.now() });

    const daily = (await systemMessages()).at(-1)!;
    expect(daily.title).toBe("rss8 daily: 1 of 1 feeds need attention");
    expect(daily.content).toMatch(/<strong>failing since .*HTTP 403<\/strong>/);
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
    const logs = log.mock.calls;
    vi.restoreAllMocks();
    return {
      discovers: sent.filter((m) => m.body.type === "discover"),
      maintenance: sent.filter((m) => m.body.type === "maintenance").map((m) => m.body),
      logs,
    };
  }

  async function enqueuedKeys(iso: string, tickConfig = at15and25): Promise<string[]> {
    const { discovers } = await tick(iso, tickConfig);
    const ids = discovers.map((m) => (m.body as { feedId: number }).feedId);
    const keys = [];
    for (const f of tickConfig.feeds) if (ids.includes(await feedId(f.key))) keys.push(f.key);
    return keys;
  }

  async function metaValue(key: string) {
    return db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<string>("value");
  }

  it("enqueues discover for feeds due on the tick, by their schedule in the config time zone", async () => {
    // 01:00 UTC is 09:00 SGT: the hourly default is due, 09:07 is not yet.
    expect((await tick("2026-10-25T01:00:00Z")).discovers).toEqual([
      { body: { type: "discover", feedId: await feedId("hourly") } },
    ]);
    // 01:15 UTC covers 09:01-09:15 SGT.
    expect((await tick("2026-10-25T01:15:00Z")).discovers).toEqual([
      { body: { type: "discover", feedId: await feedId("odd") } },
    ]);
    expect((await tick("2026-10-25T01:30:00Z")).discovers).toEqual([]);
  });

  it("never enqueues a disabled or archived feed", async () => {
    await setup(config);
    await db.prepare("UPDATE feed SET archived_at = 1 WHERE key = 'hourly'").run();
    const worker = await setup(testConfig(config.feeds.filter((f) => f.key !== "hourly")));
    const sent = captureQueue();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.scheduled(controllerAt("2026-10-25T01:00:00Z"), engineEnv);
    expect(sent.filter((m) => m.body.type === "discover")).toEqual([]);
  });

  it("covers only its own minute on the first tick ever and records the tick", async () => {
    expect(await enqueuedKeys("2026-10-25T08:30:00Z")).toEqual([]);
    expect(await metaValue("last_tick")).toBe(String(Date.parse("2026-10-25T08:30:00Z")));
  });

  it("is due on the first tick ever when the tick's own minute matches", async () => {
    expect(await enqueuedKeys("2026-10-25T08:25:40Z")).toEqual(["at25"]);
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
    expect((await tick("2026-10-25T21:15:00Z", at15and25)).maintenance).toHaveLength(1);
    // 16:15 SGT on the previous local day: a feed and maintenance would be due if it counted.
    const stale = await tick("2026-10-25T08:15:00Z", at15and25);
    expect(stale.discovers).toEqual([]);
    expect(stale.maintenance).toEqual([]);
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
    const maintenanceSent = async (iso: string) => (await tick(iso)).maintenance;
    const message = (iso: string, date: string) => [{ type: "maintenance", date, now: Date.parse(iso) }];

    async function seedArchived(): Promise<number> {
      const gone = { key: "gone", source: "fake-feed", enabled: true, options: { url: OTHER_URL } };
      await setup(testConfig([...config.feeds, gone]));
      const id = await feedId("gone");
      // A day old: tombstoned once the feed is archived, but far from being deleted.
      await db
        .prepare("INSERT INTO item (feed_id, guid, status, title, crawled_at) VALUES (?, 'fake-old', 'ok', 'Old', ?)")
        .bind(id, Date.parse("2026-10-24T21:15:00Z"))
        .run();
      await setup(config);
      return id;
    }

    it("enqueues one message on the first tick at or after 05:15 local time and records the local date", async () => {
      expect(await maintenanceSent("2026-10-25T21:15:00Z")).toEqual(message("2026-10-25T21:15:00Z", "2026-10-26"));
      expect(await metaValue("maintenance_date")).toBe("2026-10-26");
    });

    it("enqueues none before 05:15 local time", async () => {
      // 04:45 and 05:00 SGT on a day maintenance hasn't run.
      expect(await maintenanceSent("2026-10-25T20:45:00Z")).toEqual([]);
      expect(await maintenanceSent("2026-10-25T21:00:00Z")).toEqual([]);
      expect(await metaValue("maintenance_date")).toBeNull();
    });

    it("enqueues on the next tick when the 05:15 tick is skipped", async () => {
      expect(await maintenanceSent("2026-10-25T21:00:00Z")).toEqual([]);
      expect(await maintenanceSent("2026-10-25T21:30:00Z")).toEqual(message("2026-10-25T21:30:00Z", "2026-10-26"));
    });

    it("enqueues once per local day", async () => {
      expect(await maintenanceSent("2026-10-25T21:15:00Z")).toHaveLength(1);
      expect(await maintenanceSent("2026-10-25T21:30:00Z")).toEqual([]);
      expect(await maintenanceSent("2026-10-26T15:45:00Z")).toEqual([]);
      // 00:00 SGT is a new local day, but before 05:15.
      expect(await maintenanceSent("2026-10-26T16:00:00Z")).toEqual([]);
      expect(await maintenanceSent("2026-10-26T21:15:00Z")).toEqual(message("2026-10-26T21:15:00Z", "2026-10-27"));
      expect(await metaValue("maintenance_date")).toBe("2026-10-27");
    });

    it("leaves the work to the message: the cron changes no items, delivering the message does", async () => {
      const gone = await seedArchived();

      const { maintenance } = await tick("2026-10-25T21:15:00Z");
      expect((await items()).map((r) => [r.feed_id, r.status, r.title])).toEqual([[gone, "ok", "Old"]]);

      const worker = await setup(config);
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await deliver(worker, maintenance[0]!)).toEqual({ ack: true });
      expect((await items()).filter((r) => r.feed_id === gone).map((r) => [r.status, r.title])).toEqual([
        ["purged", null],
      ]);
      expect((await systemMessages()).map((m) => m.guid)).toEqual(["system:daily:2026-10-26"]);
    });

    it("re-enqueues on the next tick when the send fails", async () => {
      const worker = await setup(config);
      captureQueue();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(engineEnv.QUEUE, "send").mockRejectedValueOnce(new Error("queue down"));

      await expect(worker.scheduled(controllerAt("2026-10-25T21:15:00Z"), engineEnv)).rejects.toThrow("queue down");
      vi.restoreAllMocks();

      expect(await metaValue("maintenance_date")).toBeNull();
      expect(await maintenanceSent("2026-10-25T21:30:00Z")).toHaveLength(1);
    });

    it("retries a failing run 600 s later, logging each attempt, and on the last acks", async () => {
      await seedArchived();
      const worker = await setup(config);
      const body = { type: "maintenance", date: "2026-10-26", now: Date.parse("2026-10-25T21:15:00Z") } as const;
      const prepare = db.prepare.bind(db);
      vi.spyOn(engineEnv.DB, "prepare").mockImplementation((sql) => {
        if (sql.startsWith("SELECT id, key, archived_at FROM feed")) throw new Error("maintenance broke");
        return prepare(sql);
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      for (const attempt of [1, 2, 3]) {
        expect(await deliver(worker, body, attempt)).toEqual({ retryDelaySeconds: 600 });
      }
      expect(await deliver(worker, body, 4)).toEqual({ ack: true });
      expect(error.mock.calls).toEqual([
        ...[1, 2, 3].map((n) => [
          `maintenance 2026-10-26: maintenance attempt ${n} of 4 failed, retrying in 10 min: maintenance broke`,
        ]),
        ["maintenance 2026-10-26: maintenance failed after 4 attempts: maintenance broke"],
      ]);
      vi.restoreAllMocks();
      expect((await items()).filter((r) => !r.guid.startsWith("system:")).map((r) => r.status)).toEqual(["ok"]);
      expect((await systemMessages()).map((m) => m.title)).toEqual(["Maintenance for 2026-10-26 failed"]);
    });
  });

  describe("tick log", () => {
    function onlyTickLine(logs: unknown[][]) {
      expect(logs).toHaveLength(1);
      expect(logs[0]![0]).toBe("tick");
      return JSON.parse(logs[0]![1] as string) as unknown;
    }

    it("logs exactly one line on a normal tick", async () => {
      const first = Date.parse("2026-10-25T08:00:00Z");
      await tick("2026-10-25T08:00:00Z", at15and25);
      const { logs } = await tick("2026-10-25T08:30:00Z", at15and25);
      expect(onlyTickLine(logs)).toEqual({
        scheduledTime: Date.parse("2026-10-25T08:30:00Z"),
        lastTick: first,
        after: first,
        stale: false,
        feeds: 2,
        maintenance: false,
      });
    });

    it("logs a null lastTick on the first tick ever and the maintenance flag on the maintenance tick", async () => {
      const at = Date.parse("2026-10-25T21:15:00Z");
      const { logs } = await tick("2026-10-25T21:15:00Z", at15and25);
      expect(onlyTickLine(logs)).toEqual({
        scheduledTime: at,
        lastTick: null,
        after: at - 60_000,
        stale: false,
        feeds: 1,
        maintenance: true,
      });
    });

    it("logs exactly one line on a stale tick", async () => {
      await tick("2026-10-25T21:15:00Z", at15and25);
      const { logs } = await tick("2026-10-25T08:15:00Z", at15and25);
      expect(onlyTickLine(logs)).toEqual({
        scheduledTime: Date.parse("2026-10-25T08:15:00Z"),
        lastTick: Date.parse("2026-10-25T21:15:00Z"),
        after: null,
        stale: true,
        feeds: 0,
        maintenance: false,
      });
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

  it("requires exactly one feed with key and source system", async () => {
    const feed = plain.feeds[0]!;
    const load = (feeds: Parameters<typeof testConfig>[0]) => () =>
      createWorker({ sources: [feedSource], config: { ...plain, feeds } });
    const rule = /exactly one feed with key "system" and source "system"/;
    expect(load([feed])).toThrow(rule);
    expect(load([feed, { ...systemFeed, key: "rss8" }])).toThrow(rule);
    expect(load([feed, { ...systemFeed, source: "fake-feed", options: { url: FEED_URL } }])).toThrow(rule);
    expect(load([feed, systemFeed, { ...systemFeed, key: "system2" }])).toThrow(rule);
    expect(load([feed, { ...systemFeed, schedule: ["0 * * * *"] }])).toThrow(/takes no options or schedule/);
    expect(load([feed, { ...systemFeed, enabled: false, category: "rss8" }])).not.toThrow();
  });

  it("rejects a duplicate feed key or a bad folder name when the deployment loads", async () => {
    const feed = plain.feeds[0]!;
    expect(() => createWorker({ sources: [feedSource], config: testConfig([feed, { ...feed }]) })).toThrow(
      `Duplicate feed key "${feed.key}"`,
    );
    expect(() =>
      createWorker({ sources: [feedSource], config: testConfig([{ ...feed, category: "News/Local" }]) }),
    ).toThrow(/category/);
  });
});
