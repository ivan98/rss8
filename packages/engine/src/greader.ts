// The Google Reader API, as FreshRSS serves it, for Reeder and Unread (design §6).
// Runs in the Api object; the Worker only forwards requests to it.

import { authenticate, authSecrets, login, writeToken, writeTokenAccepted, type AuthSecrets } from "./greader-auth";
import type { EngineEnv } from "./env";
import { bindIdQuery, syncIdQueries, type IdQuery, type Page } from "./sync-queries";

const PREFIX = "/api/greader.php";
const API = "/reader/api/0/";

/** Paths the Worker forwards to the Api object: the FreshRSS mount and Reeder's "Reader" account type at the root. */
export function isGreaderPath(pathname: string): boolean {
  return (
    pathname === PREFIX ||
    pathname.startsWith(`${PREFIX}/`) ||
    pathname === "/accounts/ClientLogin" ||
    pathname.startsWith(API)
  );
}

const READING_LIST = "user/-/state/com.google/reading-list";
const READ = "user/-/state/com.google/read";
const STARRED = "user/-/state/com.google/starred";
const LONG_ID_PREFIX = "tag:google.com,2005:reader/item/";

/** A folder's stream id. Config validation keeps `/` out of folder names. */
const label = (name: string) => `user/-/label/${name}`;

/** The most ids one `stream/items/ids` page returns; Unread asks for 100,000. */
export const MAX_IDS = 100_000;
/** The most items one `stream/contents` page returns. */
export const MAX_STREAM_ITEMS = 1_000;
/** Ids per D1 query while `stream/items/contents` streams its answer. */
export const CONTENTS_CHUNK = 250;

type Stream =
  | { kind: "reading-list" | "starred" | "read" }
  | { kind: "feed"; feedId: number }
  | { kind: "label"; name: string };

function parseStream(s: string): Stream | undefined {
  const state = /^user\/[^/]+\/state\/com\.google\/(reading-list|starred|read)$/.exec(s)?.[1];
  if (state === "reading-list" || state === "starred" || state === "read") return { kind: state };
  const name = /^user\/[^/]+\/label\/([^/]+)$/.exec(s)?.[1];
  if (name !== undefined) return { kind: "label", name };
  const feedId = /^feed\/([1-9]\d{0,15})$/.exec(s)?.[1];
  return feedId ? { kind: "feed", feedId: Number(feedId) } : undefined;
}

/**
 * FreshRSS's rule: all digits and not starting with 0 is decimal (Unread);
 * anything else is hex, bare (Reeder) or after `tag:google.com,2005:reader/item/`.
 */
export function parseItemId(raw: string): number | undefined {
  if (/^[1-9]\d*$/.test(raw)) {
    const id = Number(raw);
    return Number.isSafeInteger(id) ? id : undefined;
  }
  const hex = raw.startsWith(LONG_ID_PREFIX) ? raw.slice(LONG_ID_PREFIX.length) : raw;
  if (!/^[0-9a-fA-F]{1,16}$/.test(hex)) return undefined;
  const id = Number.parseInt(hex, 16);
  return id > 0 && Number.isSafeInteger(id) ? id : undefined;
}

export function longItemId(id: number): string {
  return LONG_ID_PREFIX + id.toString(16).padStart(16, "0");
}

/** Sums D1 rows read over one request, for its log line. */
class Meter {
  rowsRead = 0;
  rowsWritten = 0;

  add(meta: D1Meta): void {
    this.rowsRead += meta.rows_read;
    this.rowsWritten += meta.rows_written;
  }

  async all<T>(statement: D1PreparedStatement): Promise<T[]> {
    const result = await statement.all<T>();
    this.add(result.meta);
    return result.results;
  }

  async batch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
    await this.batchAll(db, statements);
  }

  async batchAll<T>(db: D1Database, statements: D1PreparedStatement[]): Promise<T[][]> {
    if (statements.length === 0) return [];
    const results = await db.batch<T>(statements);
    for (const result of results) this.add(result.meta);
    return results.map((r) => r.results);
  }
}

interface Call {
  db: D1Database;
  secrets: AuthSecrets;
  user: string;
  params: URLSearchParams;
  meter: Meter;
  /** What the log line reports about the response, besides rows read. */
  count?: number;
  /** Set when the response streams; the log line is then written when the stream ends. */
  streamed?: boolean;
}

type Handler = (call: Call) => Promise<Response>;

export async function handleGreader(request: Request, env: EngineEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(`${PREFIX}/`) ? url.pathname.slice(PREFIX.length) : url.pathname;

  // Unread accepts a server only if the bare mount answers exactly "OK".
  if (path === PREFIX || path === "/") return url.search === "" ? text("OK") : badRequest();
  if (path === "/check/compatibility") {
    return request.headers.has("Authorization") ? text("PASS") : text("FAIL: the Authorization header is not passed");
  }

  const secrets = authSecrets(env);
  if (!secrets) return text("Service Unavailable", 503);

  if (path === "/accounts/ClientLogin") {
    // Only a form body: a password in the query string would end up in request logs.
    if (request.method !== "POST") return badRequest();
    const form = new URLSearchParams(await request.text());
    const auth = await login(secrets, form.get("Email") ?? "", form.get("Passwd") ?? "");
    return auth ? text(`SID=${auth}\nLSID=null\nAuth=${auth}\n`) : unauthorized();
  }

  if (!path.startsWith(API)) return badRequest();
  const user = await authenticate(secrets, request.headers.get("Authorization"));
  if (!user) return unauthorized();

  const route = path.slice(API.length);
  const contentsOf = route === "stream/contents" || route.startsWith("stream/contents/");
  const handler = contentsOf ? streamContents : Object.hasOwn(ROUTES, route) ? ROUTES[route] : undefined;
  if (!handler) return badRequest();

  const params = new URLSearchParams(url.search);
  if (request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) {
    for (const [key, value] of new URLSearchParams(await request.text())) params.append(key, value);
  }
  if (route.startsWith("stream/contents/")) {
    // The stream id may arrive percent-encoded or with its slashes as they are.
    const s = safeDecode(route.slice("stream/contents/".length));
    if (s === undefined) return badRequest();
    params.set("s", s);
  }

  const call: Call = { db: env.DB, secrets, user, params, meter: new Meter() };
  const response = await handler(call);
  if (!call.streamed) logCall(contentsOf ? "stream/contents" : route, response.status, call);
  return response;
}

const ROUTES: Record<string, Handler> = {
  async token({ secrets, user }) {
    return text(await writeToken(secrets, user));
  },

  async "user-info"({ user }) {
    return json(JSON.stringify({ userId: user, userName: user, userProfileId: user, userEmail: "" }));
  },

  async "subscription/list"(call) {
    const feeds = await listFeeds(call);
    call.count = feeds.length;
    const subscriptions = feeds.map((f) => ({
      id: `feed/${f.id}`,
      title: f.title,
      categories: f.category === null ? [] : [{ id: label(f.category), label: f.category }],
      url: f.feed_url ?? f.site_url ?? "",
      htmlUrl: f.site_url ?? "",
      iconUrl: f.icon_url ?? "",
    }));
    return json(JSON.stringify({ subscriptions }));
  },

  async "tag/list"(call) {
    const folders = new Set((await listFeeds(call)).flatMap((f) => (f.category === null ? [] : [f.category])));
    const tags = [{ id: STARRED }, ...[...folders].map((name) => ({ id: label(name), type: "folder" }))];
    return json(JSON.stringify({ tags }));
  },

  async "stream/items/ids"(call) {
    const select = await idSelection(call);
    const n = pageSize(call.params, 20, MAX_IDS);
    const before = continuation(call.params);
    if (!select || n === undefined || before === null) return badRequest();
    const { ids, next } = await idPage(call, select, n, before);
    call.count = ids.length;
    let body = `{"itemRefs":[${ids.map((id) => `{"id":"${id}"}`).join(",")}]`;
    if (next !== undefined) body += `,"continuation":"${next}"`;
    return json(`${body}}`);
  },

  async "stream/items/contents"(call) {
    const ids = [...new Set(call.params.getAll("i").map(parseItemId))].filter((id) => id !== undefined);
    ids.sort((a, b) => b - a);
    const head = `{"id":"${READING_LIST}","updated":${Math.floor(Date.now() / 1000)},`;
    return streamItems(call, "stream/items/contents", ids, head);
  },

  async "edit-tag"(call) {
    if (!(await writeTokenAccepted(call.secrets, call.user, call.params.get("T")))) return unauthorized();
    const ids = JSON.stringify([...new Set(call.params.getAll("i").map(parseItemId))].filter((id) => id !== undefined));
    const statements: D1PreparedStatement[] = [];
    for (const [tags, value] of [
      [call.params.getAll("a"), 1],
      [call.params.getAll("r"), 0],
    ] as const) {
      for (const tag of tags) {
        // Folder labels are ignored: articles carry no labels of their own.
        const kind = parseStream(tag)?.kind;
        const sql = kind === "read" ? SET_READ : kind === "starred" ? SET_STARRED : undefined;
        if (sql) statements.push(call.db.prepare(sql).bind(ids, value));
      }
    }
    // Unknown ids, tombstones and labels are ignored: retention may have
    // removed an item the client still holds.
    await call.meter.batch(call.db, statements);
    return text("OK");
  },

  async "unread-count"(call) {
    const unread = await call.meter.all<{ id: number; feed_id: number }>(call.db.prepare(UNREAD_BY_FEED));
    const feeds = new Map<number, { count: number; newest: number }>();
    for (const { id, feed_id } of unread) {
      const feed = feeds.get(feed_id) ?? { count: 0, newest: 0 };
      feeds.set(feed_id, { count: feed.count + 1, newest: Math.max(feed.newest, id) });
    }
    const folders = new Map<string, { count: number; newest: number }>();
    for (const { id, category } of await call.meter.all<{ id: number; category: string }>(call.db.prepare(FOLDER_FEEDS))) {
      const feed = feeds.get(id);
      if (!feed) continue;
      const folder = folders.get(category) ?? { count: 0, newest: 0 };
      folders.set(category, { count: folder.count + feed.count, newest: Math.max(folder.newest, feed.newest) });
    }
    const newestIds = [...feeds.values()].map((f) => f.newest);
    const crawled = new Map(
      (await call.meter.all<{ id: number; crawled_at: number }>(
        call.db.prepare(CRAWLED_AT).bind(JSON.stringify(newestIds)),
      )).map((r) => [r.id, r.crawled_at]),
    );
    const usec = (id: number) => String((crawled.get(id) ?? 0) * 1000);
    const counts = [...feeds]
      .sort(([a], [b]) => a - b)
      .map(([feedId, f]) => ({ id: `feed/${feedId}`, count: f.count, newestItemTimestampUsec: usec(f.newest) }));
    for (const [name, f] of folders) counts.push({ id: label(name), count: f.count, newestItemTimestampUsec: usec(f.newest) });
    const newest = Math.max(0, ...newestIds);
    counts.push({ id: READING_LIST, count: unread.length, newestItemTimestampUsec: usec(newest) });
    call.count = unread.length;
    return json(JSON.stringify({ max: unread.length, unreadcounts: counts }));
  },

  async "mark-all-as-read"(call) {
    if (!(await writeTokenAccepted(call.secrets, call.user, call.params.get("T")))) return unauthorized();
    const stream = parseStream(call.params.get("s") ?? "");
    const tsMs = timestampMs(call.params.get("ts"));
    if (tsMs === undefined) return badRequest();
    if (stream?.kind === "reading-list") {
      await call.meter.batch(call.db, [call.db.prepare(MARK_ALL_READ).bind(tsMs)]);
    } else if (stream?.kind === "feed" || stream?.kind === "label") {
      const feedIds = stream.kind === "feed" ? [stream.feedId] : await folderFeedIds(call, stream.name);
      await call.meter.batch(call.db, feedIds.map((feedId) => call.db.prepare(MARK_FEED_READ).bind(tsMs, feedId)));
    } else {
      return badRequest();
    }
    return text("OK");
  },
};

interface SubscriptionRow {
  id: number;
  title: string;
  site_url: string | null;
  feed_url: string | null;
  icon_url: string | null;
  category: string | null;
  position: number | null;
}

/** Non-archived feeds in config order, with each folder's feeds moved up to where its first feed stands. */
async function listFeeds(call: Call): Promise<SubscriptionRow[]> {
  // Sorted here: ORDER BY reads every feed row twice.
  const feeds = (
    await call.meter.all<SubscriptionRow>(
      call.db.prepare(
        "SELECT id, title, site_url, feed_url, icon_url, category, position FROM feed WHERE archived_at IS NULL",
      ),
    )
  ).sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.id - b.id);
  const folderAt = new Map<string, number>();
  feeds.forEach((f, i) => {
    if (f.category !== null && !folderAt.has(f.category)) folderAt.set(f.category, i);
  });
  const at = (f: SubscriptionRow, i: number) => (f.category === null ? i : folderAt.get(f.category)!);
  return feeds
    .map((f, i) => ({ f, i, at: at(f, i) }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map(({ f }) => f);
}

/** A folder's non-archived feeds; none for a folder no feed names any more. */
async function folderFeedIds(call: Call, name: string): Promise<number[]> {
  const rows = await call.meter.all<{ id: number }>(
    call.db.prepare("SELECT id FROM feed WHERE category = ?1 AND archived_at IS NULL").bind(name),
  );
  return rows.map((r) => r.id);
}

async function streamContents(call: Call): Promise<Response> {
  const select = await idSelection(call);
  const n = pageSize(call.params, 20, MAX_STREAM_ITEMS);
  const before = continuation(call.params);
  if (!select || n === undefined || before === null) return badRequest();
  const { ids, next } = await idPage(call, select, n, before);
  const s = JSON.stringify(call.params.get("s") || READING_LIST);
  let head = `{"id":${s},"updated":${Math.floor(Date.now() / 1000)},`;
  if (next !== undefined) head += `"continuation":"${next}",`;
  return streamItems(call, "stream/contents", ids, head);
}

/** One statement, or one per feed of a folder, whose results merge into a page. */
type IdStatements = (page: Page) => D1PreparedStatement[];

/**
 * Maps `s`, `xt` and `ot` onto the indexed id queries. A combination with no
 * query is refused rather than answered with a wrong set: a client that gets
 * an incomplete unread set marks the rest read.
 */
async function idSelection(call: Call): Promise<IdStatements | undefined> {
  const { db, params } = call;
  const stream = parseStream(params.get("s") || READING_LIST);
  const xt = params.get("xt");
  const ot = params.get("ot");
  if (!stream || params.has("nt") || params.has("it")) return undefined;
  if (xt !== null && parseStream(xt)?.kind !== "read") return undefined;
  const otSeconds = ot === null ? undefined : /^\d{1,12}$/.test(ot) ? Number(ot) : NaN;
  if (Number.isNaN(otSeconds)) return undefined;

  const bind =
    <P extends Page>(query: IdQuery<P>, fixed: Omit<P, keyof Page>): IdStatements =>
    (page) => [bindIdQuery(db, query, { ...fixed, ...page } as P)];
  const excludeRead = xt !== null;
  switch (stream.kind) {
    case "reading-list":
      if (!excludeRead) return bind(syncIdQueries.readingListSince, { otSeconds: otSeconds ?? 0 });
      return otSeconds === undefined ? bind(syncIdQueries.unread, {}) : undefined;
    case "read":
      return excludeRead ? undefined : bind(syncIdQueries.readSince, { otSeconds: otSeconds ?? 0 });
    case "starred":
      return excludeRead || otSeconds !== undefined ? undefined : bind(syncIdQueries.starred, {});
    case "feed":
    case "label": {
      // Neither client was seen asking for these, so every combination is
      // answered (design §6, Folders). Each feed's query reads at most n + 1 rows.
      const feedIds = stream.kind === "feed" ? [stream.feedId] : await folderFeedIds(call, stream.name);
      const query = excludeRead ? syncIdQueries.feedUnreadSince : syncIdQueries.feedSince;
      return (page) => feedIds.map((feedId) => bindIdQuery(db, query, { feedId, otSeconds: otSeconds ?? 0, ...page }));
    }
  }
}

/** One page, newest first. Asks for one id more than `n` to know whether another page follows. */
async function idPage(call: Call, select: IdStatements, n: number, before: number | undefined) {
  const results = await call.meter.batchAll<{ id: number }>(call.db, select({ before, limit: n + 1 }));
  // Feeds' ids interleave; a single statement is already in order.
  const rows = results.length === 1 ? results[0]! : results.flat().sort((a, b) => b.id - a.id);
  const ids = rows.slice(0, n).map((r) => r.id);
  return { ids, next: rows.length > n ? ids.at(-1) : undefined };
}

function pageSize(params: URLSearchParams, fallback: number, max: number): number | undefined {
  const n = params.get("n");
  if (n === null) return fallback;
  return /^\d{1,9}$/.test(n) && Number(n) > 0 ? Math.min(Number(n), max) : undefined;
}

/** The `c` continuation: the last id of the previous page. Null when malformed. */
function continuation(params: URLSearchParams): number | undefined | null {
  const c = params.get("c");
  if (c === null || c === "") return undefined;
  return /^[1-9]\d{0,15}$/.test(c) ? Number(c) : null;
}

/** `ts` is usually microseconds; seconds and milliseconds are told apart by magnitude. Defaults to now. */
export function timestampMs(ts: string | null): number | undefined {
  if (ts === null || ts === "") return Date.now();
  if (!/^\d{1,19}$/.test(ts)) return undefined;
  const value = Number(ts);
  if (value >= 1e14) return Math.floor(value / 1000);
  if (value >= 1e11) return value;
  return value * 1000;
}

interface ItemRow {
  id: number;
  feed_id: number;
  title: string | null;
  url: string | null;
  author: string | null;
  summary: string | null;
  content: string | null;
  published_at: number | null;
  updated_at: number | null;
  crawled_at: number;
  is_read: number;
  is_starred: number;
}

interface FeedRow {
  id: number;
  title: string;
  site_url: string | null;
  category: string | null;
}

/**
 * Writes the items as JSON while it reads them, CONTENTS_CHUNK ids per query:
 * a full 9,000-item answer is about 56 MB, and building it in memory cost
 * twice the CPU (design §6). Feeds are read once and joined here, which saves
 * D1 rows read per item.
 */
function streamItems(call: Call, route: string, ids: number[], head: string): Response {
  call.streamed = true;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (chunk: string) => writer.write(encoder.encode(chunk));

  const produce = async () => {
    const feeds = new Map(
      (await call.meter.all<FeedRow>(call.db.prepare("SELECT id, title, site_url, category FROM feed"))).map((f) => [f.id, f]),
    );
    await write(`${head}"items":[`);
    let count = 0;
    for (let i = 0; i < ids.length; i += CONTENTS_CHUNK) {
      const chunk = JSON.stringify(ids.slice(i, i + CONTENTS_CHUNK));
      const rows = await call.meter.all<ItemRow>(call.db.prepare(ITEMS_BY_ID).bind(chunk));
      if (rows.length === 0) continue;
      rows.sort((a, b) => b.id - a.id);
      await write((count === 0 ? "" : ",") + rows.map((row) => renderItem(row, feeds.get(row.feed_id))).join(","));
      count += rows.length;
    }
    await write("]}");
    await writer.close();
    call.count = count;
    logCall(route, 200, call);
  };
  produce().catch(async (error: unknown) => {
    console.error("api", JSON.stringify({ route, error: String(error) }));
    await writer.abort(error);
  });
  return new Response(readable, { headers: { "Content-Type": JSON_TYPE } });
}

function renderItem(row: ItemRow, feed: FeedRow | undefined): string {
  const categories = [READING_LIST];
  if (row.is_read) categories.push(READ);
  if (row.is_starred) categories.push(STARRED);
  if (feed?.category) categories.push(label(feed.category));
  const published = row.published_at ?? Math.floor(row.crawled_at / 1000);
  const link = row.url ? [{ href: row.url, type: "text/html" }] : [];
  return JSON.stringify({
    id: longItemId(row.id),
    crawlTimeMsec: String(row.crawled_at),
    timestampUsec: String(row.crawled_at * 1000),
    published,
    updated: row.updated_at ?? published,
    title: row.title ?? "",
    author: row.author ?? undefined,
    canonical: link,
    alternate: link,
    categories,
    origin: { streamId: `feed/${row.feed_id}`, title: feed?.title ?? "", htmlUrl: feed?.site_url ?? "" },
    summary: { content: row.content ?? row.summary ?? "" },
  });
}

// Every statement keeps `status = 'ok'` literal so it matches the partial
// indexes, and so tombstones and unfinished items stay invisible and unchanged.
// A lookup by a JSON list of ids reads two rows per id: the json_each entry
// and the item. Sorting in SQL would add a third, so callers sort.
export const ITEMS_BY_ID = `
SELECT i.id, i.feed_id, i.title, i.url, i.author, i.summary, i.content, i.published_at, i.updated_at, i.crawled_at,
       i.is_read, i.is_starred
FROM json_each(?1) AS j JOIN item AS i ON i.id = j.value WHERE i.status = 'ok'`;

// UPDATE … FROM reads one row fewer per id than WHERE id IN (SELECT …).
export const SET_READ = `UPDATE item SET is_read = ?2 FROM json_each(?1) AS j
WHERE item.id = j.value AND item.status = 'ok' AND item.is_read != ?2`;
export const SET_STARRED = `UPDATE item SET is_starred = ?2 FROM json_each(?1) AS j
WHERE item.id = j.value AND item.status = 'ok' AND item.is_starred != ?2`;

// Ids grow with crawled_at (design §5), so "crawled at or before ts" is "id at
// or below the last id crawled by ts": one item_crawled lookup, then a range
// on item_unread.
const LAST_ID_BY = "(SELECT id FROM item WHERE crawled_at <= ?1 ORDER BY crawled_at DESC LIMIT 1)";
export const MARK_ALL_READ = `UPDATE item SET is_read = 1 WHERE status = 'ok' AND is_read = 0 AND id <= ${LAST_ID_BY}`;
export const MARK_FEED_READ = `UPDATE item SET is_read = 1 WHERE status = 'ok' AND is_read = 0 AND id <= ${LAST_ID_BY} AND feed_id = ?2`;

// The unread set itself, one row read per unread item, counted per feed in JS:
// GROUP BY in SQL needs a temporary B-tree that doubles the rows read.
export const UNREAD_BY_FEED = "SELECT id, feed_id FROM item WHERE status = 'ok' AND is_read = 0";
const FOLDER_FEEDS = "SELECT id, category FROM feed WHERE category IS NOT NULL AND archived_at IS NULL";
const CRAWLED_AT = "SELECT i.id, i.crawled_at FROM json_each(?1) AS j JOIN item AS i ON i.id = j.value";

function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

const JSON_TYPE = "application/json; charset=utf-8";

function json(body: string): Response {
  return new Response(body, { headers: { "Content-Type": JSON_TYPE } });
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

function badRequest(): Response {
  return text("Bad Request!", 400);
}

function unauthorized(): Response {
  return text("Unauthorized!", 401, { "Google-Bad-Token": "true" });
}

/** One line per API call, never with headers or parameters: they carry tokens. */
function logCall(route: string, status: number, call: Call): void {
  const { rowsRead, rowsWritten } = call.meter;
  console.log("api", JSON.stringify({ route, status, count: call.count ?? null, rowsRead, rowsWritten }));
}
