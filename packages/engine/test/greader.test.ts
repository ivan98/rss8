import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGreader, ITEMS_BY_ID, MARK_ALL_READ, MARK_FEED_READ, SET_READ, UNREAD_BY_FEED } from "../src/greader";
import { longItemId, parseItemId, runMaintenance } from "../src/index";
import { db, engineEnv, testConfig } from "./fakes";
import {
  call,
  Client,
  formBody,
  hex16,
  login,
  PASSWORD,
  READ,
  READING_LIST,
  seed,
  STARRED,
  state,
  type SeedItem,
} from "./greader-client";

const DAY_MS = 86_400_000;
const NOW_MS = 1_800_000_000_000;

/** Ids 1..count, one hour apart, the newest crawled an hour before NOW_MS. */
function hourly(count: number, f: (id: number) => Partial<SeedItem> = () => ({})): SeedItem[] {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, crawledAt: NOW_MS - (count - i) * 3_600_000, ...f(i + 1) }));
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => to - i);

describe("mount and login", () => {
  it("answers exactly OK on the bare FreshRSS mount, with or without the trailing slash", async () => {
    for (const path of ["/api/greader.php", "/api/greader.php/"]) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("OK");
    }
  });

  it("forwards nothing else that merely starts like the mount", async () => {
    expect((await call("/api/greader.phpx")).status).toBe(404);
    expect((await call("/reader/api/1/token")).status).toBe(404);
  });

  it("reports PASS on check/compatibility only when the Authorization header arrives", async () => {
    const pass = await call("/api/greader.php/check/compatibility", { headers: { Authorization: "GoogleLogin auth=x" } });
    expect(await pass.text()).toBe("PASS");
    expect(await (await call("/api/greader.php/check/compatibility")).text()).toMatch(/^FAIL/);
  });

  it("answers Unread's bare GET probe of ClientLogin with 400 Bad Request!", async () => {
    const res = await call("/api/greader.php/accounts/ClientLogin");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Bad Request!");
  });

  it("refuses a ClientLogin with the password in the query string", async () => {
    const res = await call(`/api/greader.php/accounts/ClientLogin?Email=test&Passwd=${PASSWORD}`);
    expect(res.status).toBe(400);
  });

  it("returns SID, LSID and Auth for the right password, at both mounts", async () => {
    for (const path of ["/api/greader.php/accounts/ClientLogin", "/accounts/ClientLogin"]) {
      const res = await call(path, formBody([["Passwd", PASSWORD], ["Email", "test"], ["service", "reader"]]));
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/^SID=(test\/[0-9a-f]{64})\nLSID=null\nAuth=\1\n$/);
    }
  });

  it("answers a wrong password with 401 Unauthorized! and Google-Bad-Token", async () => {
    const res = await call("/accounts/ClientLogin", formBody([["Email", "test"], ["Passwd", "wrong-password"]]));
    expect(res.status).toBe(401);
    expect(res.headers.get("Google-Bad-Token")).toBe("true");
    expect(await res.text()).toBe("Unauthorized!");
  });

  it("refuses API calls without a valid token", async () => {
    const auth = await login();
    for (const header of [undefined, "GoogleLogin auth=test/00", `GoogleLogin auth=other${auth.slice(4)}`, `Bearer ${auth}`]) {
      const res = await call("/reader/api/0/user-info", { headers: header ? { Authorization: header } : {} });
      expect(res.status).toBe(401);
      expect(res.headers.get("Google-Bad-Token")).toBe("true");
    }
    const ok = await call("/reader/api/0/user-info", { headers: { Authorization: `GoogleLogin auth=${auth}` } });
    expect(await ok.json()).toMatchObject({ userName: "test" });
  });

  it("refuses tokens issued before the password changed", async () => {
    const auth = await login();
    const request = new Request("https://rss8.test/reader/api/0/user-info", {
      headers: { Authorization: `GoogleLogin auth=${auth}` },
    });
    expect((await handleGreader(request.clone(), engineEnv)).status).toBe(200);
    expect((await handleGreader(request, { ...engineEnv, API_PASSWORD: "a-new-password" })).status).toBe(401);
  });

  it("refuses every login and token when a secret is missing or short", async () => {
    const auth = await login();
    const request = (path: string, init?: RequestInit) => new Request(`https://rss8.test${path}`, init);
    for (const secrets of [{ API_PASSWORD: undefined }, { AUTH_SECRET: undefined }, { AUTH_SECRET: "short" }]) {
      const broken = { ...engineEnv, ...secrets };
      const loginRes = await handleGreader(
        request("/accounts/ClientLogin", formBody([["Email", "test"], ["Passwd", PASSWORD]])),
        broken,
      );
      expect(loginRes.status).toBe(503);
      const apiRes = await handleGreader(
        request("/reader/api/0/user-info", { headers: { Authorization: `GoogleLogin auth=${auth}` } }),
        broken,
      );
      expect(apiRes.status).toBe(503);
    }
  });

  it("answers an unknown API path with 400 Bad Request!", async () => {
    const client = await Client.login();
    for (const path of ["no/such/thing", "constructor", "toString"]) {
      const res = await client.get(path);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Bad Request!");
    }
  });

  it("returns a 57-character write token", async () => {
    const client = await Client.login();
    expect(await (await client.get("token")).text()).toMatch(/^[0-9a-f]{40}Z{17}$/);
  });
});

describe("subscriptions and tags", () => {
  it("lists non-archived feeds with no folder as having no categories", async () => {
    await seed([], [1, 2, 3]);
    await db.prepare("UPDATE feed SET archived_at = 1 WHERE id = 2").run();
    const client = await Client.login();
    const body = await (await client.get("subscription/list", [["output", "json"]])).json<{ subscriptions: unknown[] }>();
    expect(body.subscriptions).toEqual([
      expect.objectContaining({ id: "feed/1", title: "Feed 1", categories: [], htmlUrl: "https://example.com/1" }),
      expect.objectContaining({ id: "feed/3", categories: [] }),
    ]);
  });

  it("lists only the starred tag", async () => {
    const client = await Client.login();
    expect(await (await client.get("tag/list", [["types", "1"]])).json()).toEqual({ tags: [{ id: STARRED }] });
  });
});

// §6, Folders: one folder per feed, from the config, in config order.
describe("folders", () => {
  const NEWS = "user/-/label/News";
  // In config order: feed 3 in News, feed 1 loose, feed 4 in Apple, feed 2 in
  // News; feed 5 archived in Old. Item id's feed is 1 + id % 5.
  const items = hourly(30, (id) => ({ feedId: 1 + (id % 5), read: id % 3 === 0 }));
  const inNews = (id: number) => [2, 3].includes(1 + (id % 5));
  const all = range(1, 30);
  beforeEach(async () => {
    await seed(items, [1, 2, 3, 4, 5]);
    await db.batch(
      [
        [3, "News", 0],
        [1, null, 1],
        [4, "Apple", 2],
        [2, "News", 3],
        [5, "Old", 4],
      ].map(([id, category, position]) =>
        db.prepare("UPDATE feed SET category = ?2, position = ?3 WHERE id = ?1").bind(id, category, position),
      ),
    );
    await db.prepare("UPDATE feed SET archived_at = 1 WHERE id = 5").run();
  });

  it("lists each feed's folder, keeping a folder's feeds together where its first feed stands", async () => {
    const client = await Client.login();
    const body = await (await client.get("subscription/list", [["output", "json"]])).json<{
      subscriptions: { id: string; categories: unknown[] }[];
    }>();
    const news = [{ id: NEWS, label: "News" }];
    expect(body.subscriptions.map((s) => [s.id, s.categories])).toEqual([
      ["feed/3", news],
      ["feed/2", news],
      ["feed/1", []],
      ["feed/4", [{ id: "user/-/label/Apple", label: "Apple" }]],
    ]);
  });

  it("lists the folders of non-archived feeds after the starred tag, in config order", async () => {
    const client = await Client.login();
    expect(await (await client.get("tag/list", [["types", "1"]])).json()).toEqual({
      tags: [{ id: STARRED }, { id: NEWS, type: "folder" }, { id: "user/-/label/Apple", type: "folder" }],
    });
  });

  it("returns a folder's complete id sets across its feeds, for every xt and ot", async () => {
    const client = await Client.login();
    const n: [string, string] = ["n", "100000"];
    const otSeconds = String(items[19]!.crawledAt / 1000);
    const news = all.filter(inNews);
    expect((await client.ids([n, ["s", NEWS]])).ids).toEqual(news);
    expect((await client.ids([n, ["s", NEWS], ["xt", READ]])).ids).toEqual(news.filter((id) => id % 3 !== 0));
    expect((await client.ids([n, ["s", NEWS], ["ot", otSeconds]])).ids).toEqual(news.filter((id) => id >= 20));
    expect((await client.ids([n, ["s", NEWS], ["xt", READ], ["ot", otSeconds]])).ids).toEqual(
      news.filter((id) => id >= 20 && id % 3 !== 0),
    );
    expect((await client.ids([n, ["s", "feed/4"], ["xt", READ]])).ids).toEqual(
      all.filter((id) => id % 5 === 3 && id % 3 !== 0),
    );
    // Any user segment, and the folder of an archived feed or a renamed one is empty.
    expect((await client.ids([n, ["s", "user/1/label/News"]])).ids).toEqual(news);
    expect((await client.ids([n, ["s", "user/-/label/Old"]])).ids).toEqual([]);
    expect((await client.ids([n, ["s", "user/-/label/news"]])).ids).toEqual([]);
  });

  it("pages a folder with c into the same set", async () => {
    const client = await Client.login();
    const pages: number[][] = [];
    let c: string | undefined;
    do {
      const page = await client.ids([["n", "5"], ["s", NEWS], ...(c ? [["c", c] as [string, string]] : [])]);
      pages.push(page.ids);
      c = page.continuation;
    } while (c);
    expect(pages.map((p) => p.length)).toEqual([5, 5, 2]);
    expect(pages.flat()).toEqual(all.filter(inNews));
  });

  it("serves a folder through stream/contents, and labels each item with its feed's folder", async () => {
    const client = await Client.login();
    const res = await client.get(`stream/contents/${encodeURIComponent(NEWS)}`, [["n", "3"]]);
    const body = await res.json<{ id: string; items: { id: string; categories: string[] }[] }>();
    expect(body.id).toBe(NEWS);
    expect(body.items.map((i) => [parseItemId(i.id), i.categories])).toEqual([
      [27, [READING_LIST, READ, NEWS]],
      [26, [READING_LIST, NEWS]],
      [22, [READING_LIST, NEWS]],
    ]);
    const loose = await client.contents(["30"]);
    expect(loose[0]!.categories).toEqual([READING_LIST, READ]);
  });

  it("counts a folder's unread items over its feeds", async () => {
    const client = await Client.login();
    const body = await (await client.get("unread-count")).json<{ unreadcounts: { id: string; count: number }[] }>();
    const unread = all.filter((id) => id % 3 !== 0);
    expect(body.unreadcounts.find((c) => c.id === NEWS)).toEqual({
      id: NEWS,
      count: unread.filter(inNews).length,
      newestItemTimestampUsec: String(items[25]!.crawledAt * 1000),
    });
    expect(body.unreadcounts.map((c) => c.id)).not.toContain("user/-/label/Old");
  });

  it("marks a folder read up to ts, and only its feeds", async () => {
    const client = await Client.login();
    const res = await client.post("mark-all-as-read", [["s", NEWS], ["ts", String(items[19]!.crawledAt * 1000)]]);
    expect(res.status).toBe(200);
    const read = (await state()).read;
    expect(read).toEqual(all.filter((id) => id % 3 === 0 || (inNews(id) && id <= 20)).reverse());
  });
});

// §6: stream/items/ids returns complete id sets; n up to 100,000; continuation.
describe("rule: complete id sets", () => {
  // 2,500 items: every third read, every tenth starred.
  const items = hourly(2_500, (id) => ({ read: id % 3 === 0, starred: id % 10 === 0, feedId: 1 + (id % 2) }));
  const all = range(1, 2_500);
  beforeEach(() => seed(items));

  it("returns every id of each set Reeder and Unread ask for, with n = 100000", async () => {
    const client = await Client.login();
    const n: [string, string] = ["n", "100000"];
    const otSeconds = String((NOW_MS - 30 * DAY_MS) / 1000);
    const since = all.filter((id) => items[id - 1]!.crawledAt >= Number(otSeconds) * 1000);
    expect(since.length).toBeLessThan(all.length);

    expect((await client.ids([n, ["s", READING_LIST], ["xt", READ]])).ids).toEqual(all.filter((id) => id % 3 !== 0));
    expect((await client.ids([n, ["s", STARRED]])).ids).toEqual(all.filter((id) => id % 10 === 0));
    expect((await client.ids([n, ["s", READ], ["ot", otSeconds]])).ids).toEqual(since.filter((id) => id % 3 === 0));
    expect((await client.ids([n, ["s", READING_LIST], ["ot", otSeconds]])).ids).toEqual(since);
    expect((await client.ids([n, ["s", READING_LIST]])).ids).toEqual(all);
    expect((await client.ids([n, ["s", "feed/2"]])).ids).toEqual(all.filter((id) => id % 2 === 1));
  });

  it("pages with c into the same complete set, with no gap or duplicate", async () => {
    const client = await Client.login();
    const pages: number[][] = [];
    let c: string | undefined;
    do {
      const page = await client.ids([["n", "700"], ["s", READING_LIST], ...(c ? [["c", c] as [string, string]] : [])]);
      pages.push(page.ids);
      c = page.continuation;
    } while (c);
    expect(pages.map((p) => p.length)).toEqual([700, 700, 700, 400]);
    expect(pages.flat()).toEqual(all);
  });

  it("gives no continuation when the set fits exactly in n", async () => {
    const client = await Client.login();
    const page = await client.ids([["n", "2500"], ["s", READING_LIST]]);
    expect(page.ids).toHaveLength(2_500);
    expect(page.continuation).toBeUndefined();
  });

  it("caps n at 100,000 and pages beyond it", async () => {
    const client = await Client.login();
    expect((await client.ids([["n", "250000"], ["s", READING_LIST]])).ids).toEqual(all);
  });

  it("refuses a filter it cannot apply instead of returning a wrong set", async () => {
    const client = await Client.login();
    for (const query of [
      [["s", READING_LIST], ["xt", READ], ["ot", "1"]],
      [["s", STARRED], ["ot", "1"]],
      [["s", READING_LIST], ["xt", STARRED]],
      [["s", READING_LIST], ["nt", "1"]],
      [["s", "user/-/label/News/Sub"]],
      [["s", READING_LIST], ["c", "abc"]],
      [["s", READING_LIST], ["n", "0"]],
    ] as [string, string][][]) {
      expect((await client.get("stream/items/ids", query)).status).toBe(400);
    }
  });
});

// §6: only status='ok' items are visible.
describe("rule: only ok items are visible", () => {
  const items = hourly(8, (id) => ({
    status: id === 3 ? "pending" : id === 5 ? "error" : id === 7 ? "purged" : "ok",
    starred: id >= 5,
    read: id === 2,
  }));
  beforeEach(() => seed(items));

  it("hides pending, error and purged items from every id set", async () => {
    const client = await Client.login();
    expect((await client.ids([["n", "1000"], ["s", READING_LIST]])).ids).toEqual([8, 6, 4, 2, 1]);
    expect((await client.ids([["n", "1000"], ["s", READING_LIST], ["xt", READ]])).ids).toEqual([8, 6, 4, 1]);
    expect((await client.ids([["n", "1000"], ["s", STARRED]])).ids).toEqual([8, 6]);
    expect((await client.ids([["n", "1000"], ["s", "feed/1"]])).ids).toEqual([8, 6, 4, 2, 1]);
  });

  it("returns no contents for them", async () => {
    const client = await Client.login();
    const got = await client.contents(["3", "5", "7", "8"]);
    expect(got.map((i) => i.id)).toEqual([longItemId(8)]);
  });

  it("leaves them unchanged on edit-tag and mark-all-as-read, and silently accepts their ids", async () => {
    const client = await Client.login();
    const res = await client.editTag([["a", READ], ["i", "3"], ["i", "5"], ["i", "7"], ["i", "999"]]);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    await client.post("mark-all-as-read", [["s", READING_LIST], ["ts", String(NOW_MS * 1000)]]);
    const { results } = await db.prepare("SELECT id, is_read FROM item WHERE status != 'ok' ORDER BY id").all();
    expect(results).toEqual([
      { id: 3, is_read: 0 },
      { id: 5, is_read: 0 },
      { id: 7, is_read: 0 },
    ]);
  });

  it("leaves them out of unread-count", async () => {
    const client = await Client.login();
    const body = await (await client.get("unread-count")).json<{ unreadcounts: { id: string; count: number }[] }>();
    expect(body.unreadcounts).toEqual([
      expect.objectContaining({ id: "feed/1", count: 4 }),
      expect.objectContaining({ id: READING_LIST, count: 4 }),
    ]);
  });
});

// §6: mark-all-as-read marks only items with crawled_at ≤ ts; ts is usually in microseconds.
describe("rule: mark-all-as-read stops at ts", () => {
  const items = hourly(6, (id) => ({ feedId: id <= 3 ? 1 : 2 }));
  const cutoffMs = items[3]!.crawledAt; // item 4 exactly at ts
  beforeEach(() => seed(items));

  for (const [unit, ts] of [
    ["microseconds", cutoffMs * 1000],
    ["milliseconds", cutoffMs],
    ["seconds", cutoffMs / 1000],
  ] as const) {
    it(`marks items crawled at or before ts given in ${unit}`, async () => {
      const client = await Client.login();
      const res = await client.post("mark-all-as-read", [["s", READING_LIST], ["ts", String(ts)]]);
      expect(res.status).toBe(200);
      expect((await state()).read).toEqual([1, 2, 3, 4]);
    });
  }

  it("marks only the named feed", async () => {
    const client = await Client.login();
    await client.post("mark-all-as-read", [["s", "feed/2"], ["ts", String(cutoffMs * 1000)]]);
    expect((await state()).read).toEqual([4]);
  });

  it("marks nothing when ts is before every item", async () => {
    const client = await Client.login();
    await client.post("mark-all-as-read", [["s", READING_LIST], ["ts", String((items[0]!.crawledAt - 1) * 1000)]]);
    expect((await state()).read).toEqual([]);
  });
});

// §6: item ids in three forms; FreshRSS's rule tells decimal from hex.
describe("rule: three item id forms", () => {
  it("parses decimal, bare 16-digit hex and the long form", () => {
    expect(parseItemId("1761120000000000")).toBe(1761120000000000);
    expect(parseItemId("000641bab401c000")).toBe(0x641bab401c000);
    expect(parseItemId("tag:google.com,2005:reader/item/000641bab401c000")).toBe(0x641bab401c000);
    // All digits but a leading 0: hex, as Reeder pads it.
    expect(parseItemId("0000000000000010")).toBe(16);
    expect(parseItemId("10")).toBe(10);
    for (const bad of ["", "0", "-5", "tag:google.com,2005:reader/item/xyz", "00000000000000000001", "99999999999999999"]) {
      expect(parseItemId(bad)).toBeUndefined();
    }
    expect(longItemId(16)).toBe("tag:google.com,2005:reader/item/0000000000000010");
  });

  it("accepts each form in contents and edit-tag", async () => {
    await seed(hourly(20));
    const client = await Client.login();
    const forms = ["17", hex16(18), longItemId(19)];
    expect((await client.contents(forms)).map((i) => i.id)).toEqual([19, 18, 17].map(longItemId));
    await client.editTag([["i", "17"], ["a", READ], ["i", hex16(18)], ["i", longItemId(19)]]);
    expect((await state()).read).toEqual([17, 18, 19]);
    // "10" is decimal ten; "0000000000000010" is hex sixteen.
    await client.editTag([["a", STARRED], ["i", "10"], ["i", hex16(16)]]);
    expect((await state()).starred).toEqual([10, 16]);
  });
});

// §6: the write token T is optional; anything else but the real token is 401.
describe("rule: optional write token", () => {
  beforeEach(() => seed(hourly(3)));

  it("accepts no T, an empty T, x, and the real token", async () => {
    const client = await Client.login();
    const token = await (await client.get("token")).text();
    for (const [i, t] of [[1, undefined], [2, ""], [3, "x"]] as const) {
      const fields: [string, string][] = [["i", String(i)], ["a", READ]];
      if (t !== undefined) fields.push(["T", t]);
      expect((await client.editTag(fields)).status).toBe(200);
    }
    expect((await client.editTag([["T", token], ["a", STARRED], ["i", "1"]])).status).toBe(200);
    expect(await state()).toEqual({ read: [1, 2, 3], starred: [1] });
  });

  it("answers any other T with 401 Unauthorized! and Google-Bad-Token, and changes nothing", async () => {
    const client = await Client.login();
    for (const t of ["stubwritetoken", "X", `${"0".repeat(40)}${"Z".repeat(17)}`]) {
      const res = await client.editTag([["i", "1"], ["a", READ], ["T", t]]);
      expect(res.status).toBe(401);
      expect(res.headers.get("Google-Bad-Token")).toBe("true");
      expect(await res.text()).toBe("Unauthorized!");
      const markAll = await client.post("mark-all-as-read", [["s", READING_LIST], ["T", t]]);
      expect(markAll.status).toBe(401);
    }
    expect(await state()).toEqual({ read: [], starred: [] });
  });
});

// §6: retention never deletes starred items.
describe("rule: retention keeps starred items", () => {
  it("keeps an item starred through edit-tag visible after maintenance tombstones its neighbours", async () => {
    const old = NOW_MS - 400 * DAY_MS;
    await seed([1, 2, 3].map((id) => ({ id, crawledAt: old + id, read: true })));
    const client = await Client.login();
    await client.editTag([["a", STARRED], ["i", "2"]]);

    await runMaintenance(db, testConfig([{ key: "feed-1", source: "example", title: "Feed 1", enabled: true }]), NOW_MS);

    expect((await client.ids([["n", "100"], ["s", STARRED]])).ids).toEqual([2]);
    expect((await client.ids([["n", "100"], ["s", READING_LIST]])).ids).toEqual([2]);
    expect((await client.contents(["2"])).map((i) => i.title)).toEqual(["Item 2"]);
  });
});

describe("edit-tag", () => {
  beforeEach(() => seed(hourly(5)));

  it("adds and removes read and starred in one call, ignoring label tags", async () => {
    const client = await Client.login();
    await client.editTag([["a", READ], ["a", STARRED], ["i", "1"], ["i", "2"]]);
    await client.editTag([["r", READ], ["i", "2"], ["a", "user/-/label/News"], ["i", "3"]]);
    expect(await state()).toEqual({ read: [1], starred: [1, 2] });
  });

  it("takes the form fields in any order", async () => {
    const client = await Client.login();
    await client.editTag([["i", "4"], ["T", "x"], ["a", "user/-/state/com.google/read"]]);
    await client.editTag([["T", "x"], ["a", "user/1/state/com.google/read"], ["i", "5"]]);
    expect((await state()).read).toEqual([4, 5]);
  });
});

describe("contents", () => {
  it("returns read and starred state in categories, newest first, with feed origin and body", async () => {
    await seed(hourly(3, (id) => ({ read: id === 2, starred: id === 3, feedId: id === 1 ? 2 : 1 })));
    const client = await Client.login();
    const items = await client.contents(["1", "2", "3", "2"]);
    expect(items.map((i) => [i.id, i.categories])).toEqual([
      [longItemId(3), [READING_LIST, STARRED]],
      [longItemId(2), [READING_LIST, READ]],
      [longItemId(1), [READING_LIST]],
    ]);
    expect(items[2]).toMatchObject({
      title: "Item 1",
      origin: { streamId: "feed/2", title: "Feed 2" },
      summary: { content: "<p>Body of 1</p>" },
    });
  });

  it("streams more ids than one chunk in complete JSON", async () => {
    await seed(hourly(600));
    const client = await Client.login();
    const items = await client.contents(range(1, 600).map(String));
    expect(items.map((i) => i.id)).toEqual(range(1, 600).map(longItemId));
  });

  it("serves stream/contents with n and continuation, the stream id percent-encoded or not", async () => {
    await seed(hourly(30, (id) => ({ read: id > 20 })));
    const client = await Client.login();
    const first = await (
      await client.get(`stream/contents/${encodeURIComponent(READING_LIST)}`, [["n", "15"], ["xt", READ]])
    ).json<{ items: { id: string }[]; continuation: string }>();
    expect(first.items.map((i) => i.id)).toEqual(range(6, 20).map(longItemId));
    const rest = await (
      await client.get(`stream/contents/${READING_LIST}`, [["n", "15"], ["xt", READ], ["c", first.continuation]])
    ).json<{ items: { id: string }[]; continuation?: string }>();
    expect(rest.items.map((i) => i.id)).toEqual(range(1, 5).map(longItemId));
    expect(rest.continuation).toBeUndefined();
  });
});

describe("unread-count", () => {
  it("counts unread ok items per feed and in total", async () => {
    await seed(hourly(7, (id) => ({ feedId: id <= 4 ? 1 : 2, read: id === 1 })));
    const client = await Client.login();
    const body = await (await client.get("unread-count")).json();
    expect(body).toEqual({
      max: 6,
      unreadcounts: [
        { id: "feed/1", count: 3, newestItemTimestampUsec: String(hourly(7)[3]!.crawledAt * 1000) },
        { id: "feed/2", count: 3, newestItemTimestampUsec: String(hourly(7)[6]!.crawledAt * 1000) },
        { id: READING_LIST, count: 6, newestItemTimestampUsec: String(hourly(7)[6]!.crawledAt * 1000) },
      ],
    });
  });
});

describe("logging", () => {
  it("logs one line per call with rows read, and never the token or parameters", async () => {
    await seed(hourly(10));
    const client = await Client.login();
    const log = vi.spyOn(console, "log");
    await client.ids([["n", "100"], ["s", READING_LIST], ["xt", READ]]);
    await client.contents(["1", "2"]);
    await client.editTag([["a", READ], ["i", "1"], ["T", "x"]]);
    const lines = log.mock.calls.filter((c) => c[0] === "api").map((c) => JSON.parse(c[1] as string));
    log.mockRestore();
    expect(lines.map((l) => [l.route, l.status, l.count])).toEqual([
      ["stream/items/ids", 200, 10],
      ["stream/items/contents", 200, 2],
      ["edit-tag", 200, null],
    ]);
    expect(lines[0].rowsRead).toBeGreaterThan(0);
    const text = JSON.stringify(log.mock.calls);
    expect(text).not.toContain(client.auth.split("/")[1]);
  });
});

// The statements outside sync-queries.ts: each must use an index, not scan.
describe("query plans", () => {
  beforeEach(() => seed(hourly(200, (id) => ({ read: id % 2 === 0 }))));

  const plan = async (sql: string, ...params: unknown[]) =>
    (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>()).results.map((r) => r.detail);

  it("reads contents by primary key", async () => {
    expect((await plan(ITEMS_BY_ID, "[1,2]")).join("\n")).toMatch(/SEARCH i USING INTEGER PRIMARY KEY/);
    const { meta } = await db.prepare(ITEMS_BY_ID).bind(JSON.stringify(range(1, 100))).all();
    // One json_each entry and one item per id.
    expect(meta.rows_read).toBe(200);
  });

  it("updates edit-tag ids by primary key", async () => {
    expect((await plan(SET_READ, "[1,2]", 1)).join("\n")).toMatch(/SEARCH item USING INTEGER PRIMARY KEY/);
    const ids = JSON.stringify(range(1, 100));
    // A changed row is read again to update item_unread and item_retain.
    expect((await db.prepare(SET_READ).bind(ids, 1).run()).meta.rows_read).toBe(50 * 2 + 50 * 4);
    expect((await db.prepare(SET_READ).bind(ids, 1).run()).meta.rows_read).toBe(200 + 1);
  });

  it("marks all as read through item_crawled and a range on item_unread, reading a few rows per change", async () => {
    const details = await plan(MARK_ALL_READ, NOW_MS);
    expect(details.join("\n")).toMatch(/item_unread \(is_read=\? AND id<\?\)/);
    expect(details.join("\n")).toMatch(/item_crawled/);
    for (const d of details) expect(d).not.toMatch(/^SCAN/);
    const { meta } = await db.prepare(MARK_ALL_READ).bind(NOW_MS).run();
    expect(meta.changes).toBe(100);
    // Each changed row is read once to find it and again to update both indexes.
    expect(meta.rows_read).toBeLessThanOrEqual(3 * 100 + 3);
    expect((await plan(MARK_FEED_READ, NOW_MS, 1)).every((d) => !/^SCAN/.test(d))).toBe(true);
  });

  it("counts unread items on item_unread, reading about one row per unread item", async () => {
    expect((await plan(UNREAD_BY_FEED)).join("\n")).toMatch(/COVERING INDEX item_unread \(is_read=\?\)/);
    const { meta } = await db.prepare(UNREAD_BY_FEED).all();
    expect(meta.rows_read).toBe(100 + 1);
  });
});

describe("worker", () => {
  it("forwards the API to the Api object unchanged, query and body included", async () => {
    await seed(hourly(3));
    const auth = await login();
    const res = await call("/reader/api/0/stream/items/contents?output=json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `GoogleLogin auth=${auth}` },
      body: "i=2",
    });
    expect((await res.json<{ items: unknown[] }>()).items).toHaveLength(1);
    expect(env.API).toBeDefined();
  });
});
