import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker, type EngineEnv } from "../src/index";
import {
  articleSource,
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
  type Worker,
} from "./fakes";

const TOKEN = "admin-token-0123456789abcdef0123";
const adminEnv = { ...engineEnv, ADMIN_TOKEN: TOKEN };
const FEED_URL = "https://example.com/feed.xml";

const config = testConfig([
  { key: "off", source: "fake-article", enabled: false, options: { url: FEED_URL } },
  { key: "on", source: "fake-article", enabled: true, options: { url: FEED_URL } },
]);

function admin(worker: Worker, path: string, init: RequestInit = {}, env: EngineEnv = adminEnv, token = TOKEN) {
  const headers = { authorization: `Bearer ${token}` };
  return worker.fetch(new Request(`https://rss8.test${path}`, { method: "POST", headers, ...init }), env);
}

function serveFeed() {
  return fakeOrigin({
    [FEED_URL]: () =>
      new Response(
        rss([
          { guid: "a", link: "https://example.com/a", pubDate: "Thu, 01 Jan 2026 00:00:00 GMT" },
          { guid: "b", link: "https://example.com/b", pubDate: "Fri, 02 Jan 2026 00:00:00 GMT" },
        ]),
      ),
    "https://example.com/a": () => new Response("<p>A</p>"),
  });
}

async function insertItem(guid: string, status: string, attempts: number): Promise<number> {
  const id = await db
    .prepare("INSERT INTO item (feed_id, guid, status, attempts, crawled_at) VALUES (?, ?, ?, ?, 0) RETURNING id")
    .bind(await feedId("on"), guid, status, attempts)
    .first<number>("id");
  return id!;
}

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("admin auth", () => {
  let worker: Worker;
  beforeEach(async () => {
    worker = await setup(config);
  });

  it("answers 503 on every admin route without a token of at least 32 characters", async () => {
    expect(engineEnv.ADMIN_TOKEN).toBeUndefined();
    for (const env of [engineEnv, { ...engineEnv, ADMIN_TOKEN: TOKEN.slice(0, 31) }]) {
      expect((await admin(worker, "/admin/requeue?status=error", {}, env)).status).toBe(503);
      expect((await admin(worker, "/admin/nope", {}, env)).status).toBe(503);
    }
  });

  it("answers 401 to a missing, wrong or truncated token", async () => {
    const queue = captureQueue();
    const missing = await worker.fetch(
      new Request("https://rss8.test/admin/requeue?status=error", { method: "POST" }),
      adminEnv,
    );
    expect(missing.status).toBe(401);
    expect((await admin(worker, "/admin/requeue?status=error", {}, adminEnv, "x".repeat(32))).status).toBe(401);
    expect((await admin(worker, "/admin/requeue?status=error", {}, adminEnv, TOKEN.slice(0, -1))).status).toBe(401);
    expect((await admin(worker, "/admin/nope", {}, adminEnv, "wrong")).status).toBe(401);
    expect(queue).toEqual([]);
  });

  it("answers 404 to an unknown route and 405 to a wrong method", async () => {
    expect((await admin(worker, "/admin/nope")).status).toBe(404);
    expect((await admin(worker, "/admin/requeue?status=error", { method: "GET" })).status).toBe(405);
  });
});

describe("POST /admin/discover", () => {
  it("runs a disabled feed that a queued discover skips, returning the new item ids", async () => {
    const worker = await setup(config);
    const sent = captureQueue();
    serveFeed();

    expect(await deliver(worker, { type: "discover", feedId: await feedId("off") })).toEqual({ ack: true });
    expect(await items()).toEqual([]);

    const res = await admin(worker, "/admin/discover?feed=off");
    expect(res.status).toBe(200);
    const rows = await items();
    expect(rows.map((r) => [r.guid, r.status, r.feed_id])).toEqual([
      ["fake-a", "pending", await feedId("off")],
      ["fake-b", "pending", await feedId("off")],
    ]);
    expect(await res.json()).toEqual({ itemIds: rows.map((r) => r.id) });
    expect(sent.map((m) => m.body)).toEqual(rows.map((r) => ({ type: "article", itemId: r.id })));
  });

  it("returns the ids of a source whose items are complete, and none on a repeat", async () => {
    const worker = await setup(testConfig([{ key: "plain", source: "fake-feed", enabled: true, options: { url: FEED_URL } }]));
    const sent = captureQueue();
    serveFeed();

    const first = (await (await admin(worker, "/admin/discover?feed=plain")).json()) as { itemIds: number[] };
    expect(first.itemIds).toEqual((await items()).map((r) => r.id));
    expect(first.itemIds).toHaveLength(2);
    expect(await (await admin(worker, "/admin/discover?feed=plain")).json()).toEqual({ itemIds: [] });
    expect(sent).toEqual([]);
  });

  it("syncs the config before looking the feed up", async () => {
    const worker = createWorker({ sources: [feedSource, articleSource], config });
    captureQueue();
    serveFeed();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM feed").first<number>("n")).toBe(0);

    const res = await admin(worker, "/admin/discover?feed=on");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { itemIds: number[] }).itemIds).toHaveLength(2);
  });

  it("answers 404 for an unknown or archived key and 400 without one", async () => {
    const worker = await setup(config);
    await db.prepare("UPDATE feed SET archived_at = 1 WHERE key = 'on'").run();
    const requests = serveFeed();

    expect((await admin(worker, "/admin/discover?feed=nope")).status).toBe(404);
    expect((await admin(worker, "/admin/discover?feed=on")).status).toBe(404);
    expect((await admin(worker, "/admin/discover")).status).toBe(400);
    expect(requests).toEqual([]);
  });
});

describe("POST /admin/article", () => {
  it("fetches a pending item's article and reports its status", async () => {
    const worker = await setup(config);
    captureQueue();
    serveFeed();
    const { itemIds } = (await (await admin(worker, "/admin/discover?feed=on")).json()) as { itemIds: number[] };
    const id = itemIds[0]!;

    const res = await admin(worker, `/admin/article?id=${id}`);

    expect(await res.json()).toEqual({ id, status: "ok" });
    expect((await items()).find((r) => r.id === id)?.content).toBe("<p>A</p>");
  });

  it("answers 404 for an unknown item and 400 for an id that isn't decimal", async () => {
    const worker = await setup(config);
    expect((await admin(worker, "/admin/article?id=999")).status).toBe(404);
    expect((await admin(worker, "/admin/article?id=0x10")).status).toBe(400);
    expect((await admin(worker, "/admin/article")).status).toBe(400);
  });
});

describe("POST /admin/requeue", () => {
  it("sets error items back to pending and queues one article message each", async () => {
    const worker = await setup(config);
    const sent = captureQueue();
    const failed = [await insertItem("e1", "error", 4), await insertItem("e2", "error", 2)];
    const pending = await insertItem("p", "pending", 1);
    const ok = await insertItem("o", "ok", 1);

    const res = await admin(worker, "/admin/requeue?status=error");

    expect(await res.json()).toEqual({ requeued: 2 });
    expect((await items()).map((r) => [r.id, r.status, r.attempts])).toEqual([
      [failed[0], "pending", 0],
      [failed[1], "pending", 0],
      [pending, "pending", 1],
      [ok, "ok", 1],
    ]);
    expect(sent).toEqual([
      { body: { type: "article", itemId: failed[0] }, delaySeconds: 0 },
      { body: { type: "article", itemId: failed[1] }, delaySeconds: 2 },
    ]);
  });

  it("accepts only status=error", async () => {
    const worker = await setup(config);
    const sent = captureQueue();
    await insertItem("p", "pending", 1);
    expect((await admin(worker, "/admin/requeue?status=pending")).status).toBe(400);
    expect((await admin(worker, "/admin/requeue")).status).toBe(400);
    expect(sent).toEqual([]);
  });
});

describe("/admin/clean", () => {
  it("processes a page behind the token without DEV_ROUTES, while /dev/clean stays off", async () => {
    const worker = await setup(config);
    fakeOrigin({ "https://example.com/article/7": () => new Response("  hello ") });

    const fetched = await admin(worker, "/admin/clean/fake-article/7", { method: "GET" });
    expect(await fetched.json()).toEqual({ content: "HELLO", details: { bytes: 8 } });
    const posted = await admin(worker, "/admin/clean/fake-article/7?stage=trim", { body: " saved " });
    expect(await posted.json()).toEqual({ content: "saved", details: { bytes: 7 } });

    expect((await admin(worker, "/dev/clean/fake-article/7", { method: "GET" })).status).toBe(404);
    const anonymous = await worker.fetch(new Request("https://rss8.test/admin/clean/fake-article/7"), adminEnv);
    expect(anonymous.status).toBe(401);
  });
});
