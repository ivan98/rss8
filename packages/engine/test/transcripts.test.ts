// Replays the scrubbed Reeder and Unread sessions captured in Phase 0
// (transcripts/) against the real API on seeded D1. The stub
// recorded requests but no response bodies, so each response is checked
// against a model of the read and starred state that the requests build up.

import { describe, expect, it } from "vitest";
import readerAccount from "./transcripts/reeder-reader-account.json";
import reederRun1 from "./transcripts/reeder-run1.json";
import reederRun2 from "./transcripts/reeder-run2.json";
import unreadMarkUnread from "./transcripts/unread-mark-unread.json";
import unread from "./transcripts/unread.json";
import { longItemId, parseItemId } from "../src/index";
import { db } from "./fakes";
import {
  call,
  login,
  PASSWORD,
  READ,
  seed,
  state,
  STARRED,
  type ContentItem,
} from "./greader-client";

interface Recorded {
  seq: number;
  method: string;
  path: string;
  query: [string, string][];
  headers: Record<string, string>;
  body: { form?: [string, string][]; status: number };
}

const transcripts: Record<string, Recorded[]> = {
  "reeder-run1": reederRun1 as unknown as Recorded[],
  "reeder-run2": reederRun2 as unknown as Recorded[],
  "reeder-reader-account": readerAccount as unknown as Recorded[],
  unread: unread as unknown as Recorded[],
  "unread-mark-unread": unreadMarkUnread as unknown as Recorded[],
};

/** Where the contract (design §6) differs from what the logging stub answered. */
const EXPECTED_STATUS: Record<string, Record<number, number>> = {
  // Unread probes ClientLogin with a bare GET; FreshRSS answers 400 and Unread carries on.
  unread: { 2: 400 },
};

const REDACTED_AUTH = "GoogleLogin auth=<redacted>";
const STUB_WRITE_TOKEN = "stubwritetoken";

const fields = (r: Recorded) => [...r.query, ...(r.body.form ?? [])];
const values = (r: Recorded, name: string) => fields(r).filter(([k]) => k === name).map(([, v]) => v);
const value = (r: Recorded, name: string) => values(r, name)[0];

/**
 * Every item id the session mentions becomes an `ok` item with that id, so the
 * client's own id strings (decimal or 16-digit hex) reach the parser. The stub
 * ids are microsecond timestamps; crawl times keep their order, shifted so the
 * first `ot` falls in the middle of them and the `ot` calls return a real subset.
 */
function seedFor(recorded: Recorded[]) {
  const ids = [...new Set(recorded.flatMap((r) => values(r, "i")).map((raw) => parseItemId(raw)!))].sort((a, b) => a - b);
  const firstOt = Number(recorded.map((r) => value(r, "ot")).find((ot) => ot !== undefined));
  const middle = Math.floor(ids[Math.floor(ids.length / 2)]! / 1000);
  const crawledAt = (id: number) => Math.floor(id / 1000) - middle + firstOt * 1000;
  // A pending item and a tombstone next to them must never show up.
  const hidden = [
    { id: ids[0]! - 1, crawledAt: crawledAt(ids[0]! - 1), status: "pending" as const },
    { id: ids.at(-1)! + 1, crawledAt: crawledAt(ids.at(-1)! + 1), status: "purged" as const },
  ];
  return { ids, crawledAt, items: [...ids.map((id) => ({ id, crawledAt: crawledAt(id) })), ...hidden] };
}

describe.each(Object.entries(transcripts))("%s", (name, recorded) => {
  it("replays every request with the contracted status and a correct answer", async () => {
    const { ids, crawledAt, items } = seedFor(recorded);
    expect(ids.length).toBeGreaterThan(0);
    await seed(items, [1]);

    const read = new Set<number>();
    const starred = new Set<number>();
    // Sessions captured after the client had logged in carry only the scrubbed token.
    let auth = recorded.some((r) => r.path.endsWith("/accounts/ClientLogin") && r.method === "POST")
      ? undefined
      : await login();
    let writeToken: string | undefined;
    const otSplits: number[] = [];

    for (const r of recorded) {
      const url = new URL(`https://rss8.test${r.path}`);
      for (const [k, v] of r.query) url.searchParams.append(k, v);
      const headers = new Headers();
      for (const [k, v] of Object.entries(r.headers)) {
        if (k === "content-length") continue;
        headers.set(k, v === REDACTED_AUTH ? `GoogleLogin auth=${auth}` : v);
      }
      let body: string | undefined;
      if (r.body.form) {
        if (r.body.form.some(([k, v]) => k === "T" && v === STUB_WRITE_TOKEN)) {
          writeToken ??= await (await call("/reader/api/0/token", { headers: { Authorization: `GoogleLogin auth=${auth}` } })).text();
        }
        body = new URLSearchParams(
          r.body.form.map(([k, v]) => [
            k,
            k === "Passwd" ? PASSWORD : k === "T" && v === STUB_WRITE_TOKEN ? writeToken! : v,
          ]),
        ).toString();
      }

      const res = await call(url.pathname + url.search, { method: r.method, headers, body });
      const step = `#${r.seq} ${r.method} ${r.path}`;
      expect(res.status, step).toBe(EXPECTED_STATUS[name]?.[r.seq] ?? 200);
      const endpoint = r.path.replace(/^\/api\/greader\.php/, "");

      if (endpoint === "") {
        expect(await res.text(), step).toBe("OK");
      } else if (endpoint === "/accounts/ClientLogin" && r.method === "POST") {
        auth = /^Auth=(.+)$/m.exec(await res.text())?.[1];
        expect(auth, step).toMatch(/^test\//);
      } else if (endpoint === "/reader/api/0/token") {
        writeToken = await res.text();
        expect(writeToken, step).toHaveLength(57);
      } else if (endpoint === "/reader/api/0/user-info") {
        expect(await res.json(), step).toMatchObject({ userName: "test" });
      } else if (endpoint === "/reader/api/0/subscription/list") {
        const { subscriptions } = await res.json<{ subscriptions: { id: string; categories: unknown[] }[] }>();
        expect(subscriptions, step).toEqual([expect.objectContaining({ id: "feed/1", categories: [] })]);
      } else if (endpoint === "/reader/api/0/tag/list") {
        expect(await res.json(), step).toEqual({ tags: [{ id: STARRED }] });
      } else if (endpoint === "/reader/api/0/stream/items/ids") {
        const s = value(r, "s")!;
        const ot = value(r, "ot");
        const since = (id: number) => ot === undefined || crawledAt(id) >= Number(ot) * 1000;
        const want = ids
          .filter((id) =>
            s.endsWith("/starred")
              ? starred.has(id)
              : s.endsWith("/read")
                ? read.has(id) && since(id)
                : value(r, "xt") !== undefined
                  ? !read.has(id)
                  : since(id),
          )
          .reverse();
        const got = await res.json<{ itemRefs: { id: string }[]; continuation?: string }>();
        expect(got.itemRefs.map((ref) => Number(ref.id)), step).toEqual(want);
        expect(got.continuation, step).toBeUndefined();
        if (ot !== undefined && s.endsWith("/reading-list")) otSplits.push(want.length);
      } else if (endpoint === "/reader/api/0/stream/items/contents") {
        const asked = values(r, "i").map((raw) => parseItemId(raw)!);
        const got = (await res.json<{ items: ContentItem[] }>()).items;
        expect(got.map((item) => item.id), step).toEqual([...asked].sort((a, b) => b - a).map(longItemId));
        for (const item of got) {
          const id = parseItemId(item.id)!;
          expect(item.categories.includes(READ), `${step} read ${id}`).toBe(read.has(id));
          expect(item.categories.includes(STARRED), `${step} starred ${id}`).toBe(starred.has(id));
        }
      } else if (endpoint === "/reader/api/0/edit-tag") {
        expect(await res.text(), step).toBe("OK");
        const tagged = values(r, "i").map((raw) => parseItemId(raw)!);
        for (const [field, add] of [["a", true], ["r", false]] as const) {
          for (const tag of values(r, field)) {
            const set = tag.endsWith("/read") ? read : tag.endsWith("/starred") ? starred : undefined;
            for (const id of tagged) {
              if (add) set?.add(id);
              else set?.delete(id);
            }
          }
        }
        const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
        expect(await state(), step).toEqual({ read: sorted(read), starred: sorted(starred) });
      } else if (endpoint === "/accounts/ClientLogin") {
        expect(await res.text(), step).toBe("Bad Request!");
      } else {
        throw new Error(`${step}: the replay has no check for this endpoint`);
      }
    }

    // The hidden items stayed hidden and untouched.
    const { results } = await db.prepare("SELECT is_read, is_starred FROM item WHERE status != 'ok'").all();
    expect(results).toEqual([
      { is_read: 0, is_starred: 0 },
      { is_read: 0, is_starred: 0 },
    ]);
    // At least the first `ot` call returned a proper, non-empty subset.
    const reading = otSplits[0];
    if (reading !== undefined) expect(reading > 0 && reading < ids.length).toBe(true);
  });
});
