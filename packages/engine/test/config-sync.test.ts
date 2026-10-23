import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { syncConfig, type Config, type FeedConfig } from "../src/index";

const db = env.DB;
const KINDS = ["example", "other"];

function config(...feeds: FeedConfig[]): Config {
  return { timezone: "UTC", retention: { readDays: 30, unreadDays: 90, maxItems: 1000 }, tombstoneDays: 365, feeds };
}

const feedA: FeedConfig = {
  key: "feed-a",
  source: "example",
  enabled: true,
  title: "Feed A",
  siteUrl: "https://a.example",
  options: { sections: [1, 2] },
};
const feedB: FeedConfig = { key: "feed-b", source: "example", enabled: true };

// @ts-expect-error tombstoneDays is global and cannot be set per feed
const _perFeedTombstone: FeedConfig = { ...feedB, retention: { tombstoneDays: 1 } };

interface FeedRow {
  id: number;
  key: string;
  source: string;
  options: string | null;
  state: string | null;
  enabled: number;
  archived_at: number | null;
  title: string;
  site_url: string | null;
}

async function feeds(): Promise<FeedRow[]> {
  const { results } = await db
    .prepare(
      "SELECT id, key, source, options, state, enabled, archived_at, title, site_url FROM feed ORDER BY key",
    )
    .all<FeedRow>();
  return results;
}

async function feed(key: string): Promise<FeedRow> {
  const row = (await feeds()).find((f) => f.key === key);
  if (!row) throw new Error(`no feed ${key}`);
  return row;
}

async function addItem(feedKey: string, guid: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO item (feed_id, guid, status, crawled_at, is_starred) SELECT id, ?2, 'ok', 0, 1 FROM feed WHERE key = ?1",
    )
    .bind(feedKey, guid)
    .run();
}

async function itemGuids(feedKey: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT guid FROM item JOIN feed ON feed.id = item.feed_id WHERE feed.key = ? ORDER BY guid",
    )
    .bind(feedKey)
    .all<{ guid: string }>();
  return results.map((r) => r.guid);
}

async function metaRows(): Promise<unknown[]> {
  return (await db.prepare("SELECT key, value FROM meta").all()).results;
}

async function setState(key: string, state: string): Promise<void> {
  await db.prepare("UPDATE feed SET state = ? WHERE key = ?").bind(state, key).run();
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM item"),
    db.prepare("DELETE FROM feed_url"),
    db.prepare("DELETE FROM feed"),
    db.prepare("DELETE FROM meta"),
  ]);
});

describe("syncConfig", () => {
  it("inserts a new feed with its config fields and stores the config hash", async () => {
    await syncConfig(db, config(feedA, feedB), KINDS);

    expect(await feeds()).toEqual([
      {
        id: expect.any(Number),
        key: "feed-a",
        source: "example",
        options: '{"sections":[1,2]}',
        state: null,
        enabled: 1,
        archived_at: null,
        title: "Feed A",
        site_url: "https://a.example",
      },
      {
        id: expect.any(Number),
        key: "feed-b",
        source: "example",
        options: null,
        state: null,
        enabled: 1,
        archived_at: null,
        title: "feed-b",
        site_url: null,
      },
    ]);
    const hash = await db.prepare("SELECT value FROM meta WHERE key = 'config_hash'").first("value");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes nothing when the config is unchanged", async () => {
    await syncConfig(db, config(feedA), KINDS);
    await db.prepare("UPDATE feed SET title = 'edited in D1', archived_at = 1").run();

    await syncConfig(db, config(feedA), KINDS);

    expect(await feed("feed-a")).toMatchObject({ title: "edited in D1", archived_at: 1 });
  });

  it("keeps a disabled feed, its id and its items", async () => {
    await syncConfig(db, config(feedA), KINDS);
    const { id } = await feed("feed-a");
    await addItem("feed-a", "example-1");

    await syncConfig(db, config({ ...feedA, enabled: false }), KINDS);

    expect(await feed("feed-a")).toMatchObject({ id, enabled: 0, archived_at: null });
    expect(await itemGuids("feed-a")).toEqual(["example-1"]);
  });

  it("archives a removed feed and keeps its items", async () => {
    await syncConfig(db, config(feedA, feedB), KINDS);
    await addItem("feed-a", "example-1");
    const before = Date.now();

    await syncConfig(db, config(feedB), KINDS);

    const archived = (await feed("feed-a")).archived_at;
    expect(archived).toBeGreaterThanOrEqual(before);
    expect(archived).toBeLessThanOrEqual(Date.now());
    expect(await feed("feed-b")).toMatchObject({ archived_at: null });
    expect(await itemGuids("feed-a")).toEqual(["example-1"]);
  });

  it("keeps the first archive time when a later sync still omits the feed", async () => {
    await syncConfig(db, config(feedA, feedB), KINDS);
    await syncConfig(db, config(feedB), KINDS);
    await db.prepare("UPDATE feed SET archived_at = 1 WHERE key = 'feed-a'").run();

    await syncConfig(db, config({ ...feedB, title: "B renamed" }), KINDS);

    expect(await feed("feed-a")).toMatchObject({ archived_at: 1 });
  });

  it("un-archives a removed feed that returns, under the same id", async () => {
    await syncConfig(db, config(feedA, feedB), KINDS);
    const { id } = await feed("feed-a");
    await syncConfig(db, config(feedB), KINDS);

    await syncConfig(db, config(feedA, feedB), KINDS);

    expect(await feed("feed-a")).toMatchObject({ id, archived_at: null });
  });

  it("keeps the source's state on a title change", async () => {
    await syncConfig(db, config(feedA), KINDS);
    await setState("feed-a", '{"cursor":7}');

    await syncConfig(db, config({ ...feedA, title: "Renamed" }), KINDS);

    expect(await feed("feed-a")).toMatchObject({ title: "Renamed", state: '{"cursor":7}' });
  });

  it("clears the state when the feed's source changes", async () => {
    await syncConfig(db, config(feedA), KINDS);
    await setState("feed-a", '{"cursor":7}');

    await syncConfig(db, config({ ...feedA, source: "other" }), KINDS);

    expect(await feed("feed-a")).toMatchObject({ source: "other", state: null });
  });

  it("rejects duplicate feed keys and writes nothing", async () => {
    await syncConfig(db, config(feedA), KINDS);
    const snapshot = await feeds();
    const meta = await metaRows();

    await expect(
      syncConfig(db, config(feedA, { ...feedB, key: "feed-a" }, feedB), KINDS),
    ).rejects.toThrow(/Duplicate feed key "feed-a"/);

    expect(await feeds()).toEqual(snapshot);
    expect(await metaRows()).toEqual(meta);
  });

  it("rejects an unknown source and writes nothing", async () => {
    await expect(
      syncConfig(db, config(feedA, { ...feedB, source: "missing" }), KINDS),
    ).rejects.toThrow(/unknown source "missing"/);

    expect(await feeds()).toEqual([]);
    expect(await metaRows()).toEqual([]);
  });

  it("rejects an unknown source even when the config hash is unchanged", async () => {
    await syncConfig(db, config(feedA), KINDS);

    await expect(syncConfig(db, config(feedA), ["other"])).rejects.toThrow(/unknown source/);
  });
});
