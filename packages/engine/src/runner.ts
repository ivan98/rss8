import { DurableObject } from "cloudflare:workers";
import { discoverContext, sourceContext } from "./context";
import type { EngineEnv } from "./env";
import { runInspect, type InspectRequest } from "./inspect";
import { runMaintenance } from "./maintenance";
import { parseMessage, sendAll } from "./messages";
import { getConfig, getSource, parseOptions, type Candidate } from "./source";

const KEEP_NEWEST = 100;
const ARTICLE_STAGGER_SECONDS = 2;
// Each insert binds its candidates as one JSON string; D1 caps a bound value at 2 MB.
const INSERT_CHUNK_BYTES = 1024 * 1024;

/**
 * One unit of work per request, called by the queue consumer with the message
 * as the body, at `/<message type>`: `/discover`, `/article` or `/maintenance`.
 * Everything durable goes to D1; the object keeps nothing between requests.
 * `/inspect` serves the `/dev/clean` route and writes nothing.
 */
export class Runner extends DurableObject<EngineEnv> {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/inspect") {
      return runInspect((await request.json()) as InspectRequest).catch(
        (error: unknown) => new Response(error instanceof Error ? error.message : String(error), { status: 500 }),
      );
    }
    const message = parseMessage(await request.json().catch(() => undefined));
    const path = new URL(request.url).pathname;
    if (!message || path !== `/${message.type}`) return new Response("Bad Request", { status: 400 });
    try {
      switch (message.type) {
        case "discover":
          await discover(this.env, message.feedId, Date.now());
          break;
        case "article":
          await article(this.env, message.itemId);
          break;
        case "maintenance": {
          const report = await runMaintenance(this.env.DB, getConfig(), message.now);
          console.log("maintenance", JSON.stringify({ date: message.date, ...report }));
          break;
        }
      }
      return new Response("OK");
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  }
}

interface FeedRow {
  id: number;
  key: string;
  source: string;
  options: string | null;
  state: string | null;
  title: string;
  site_url: string | null;
}

async function discover(env: EngineEnv, feedId: number, now: number): Promise<void> {
  const db = env.DB;
  const feed = await db
    .prepare(
      "SELECT id, key, source, options, state, title, site_url FROM feed WHERE id = ? AND enabled = 1 AND archived_at IS NULL",
    )
    .bind(feedId)
    .first<FeedRow>();
  if (!feed) return;

  const source = getSource(feed.source);
  const options = parseOptions(source, feed.options === null ? undefined : JSON.parse(feed.options));
  const run = discoverContext(db, feed, options);
  const candidates = await source.discover(
    { id: feed.id, key: feed.key, title: feed.title, ...(feed.site_url ? { siteUrl: feed.site_url } : {}) },
    run.ctx,
  );

  const status = source.fetchArticle ? "pending" : "ok";
  const inserts = insertChunks(newest(candidates, KEEP_NEWEST).reverse()).map((chunk) =>
    db.prepare(INSERT_ITEMS).bind(feed.id, status, now, JSON.stringify(chunk)),
  );
  const warning = run.warnings.length ? `warning: ${run.warnings.join("; ")}` : null;
  const results = await db.batch<{ id: number }>([
    ...inserts,
    ...run.pending,
    db.prepare("UPDATE feed SET last_fetched_at = ?, last_error = ? WHERE id = ?").bind(now, warning, feed.id),
  ]);

  if (!source.fetchArticle) return;
  const inserted = results
    .slice(0, inserts.length)
    .flatMap((r) => r.results.map((row) => row.id))
    .sort((a, b) => a - b);
  await sendAll(
    env.QUEUE,
    inserted.map((itemId, i) => ({
      body: { type: "article", itemId },
      delaySeconds: i * ARTICLE_STAGGER_SECONDS,
    })),
  );
}

// `crawled_at` must never decrease as `id` grows (the sync queries turn a time
// bound into an id bound), so a clock that steps back reuses the latest value.
// RETURNING yields only the rows actually inserted, not the ignored duplicates.
const INSERT_ITEMS = `
INSERT OR IGNORE INTO item
  (feed_id, guid, status, url, title, summary, author, content, published_at, updated_at, crawled_at)
SELECT ?1, c.value ->> 'guid', ?2, c.value ->> 'url', c.value ->> 'title', c.value ->> 'summary',
  c.value ->> 'author', c.value ->> 'content', c.value ->> 'published', c.value ->> 'updated',
  MAX(?3, COALESCE((SELECT MAX(crawled_at) FROM item), 0))
FROM json_each(?4) AS c
ORDER BY c.key
RETURNING id`;

/**
 * The newest `limit` candidates by date (published, else updated), newest
 * first. Undated candidates follow the dated ones in document order. Some
 * feeds list oldest first, so the first `limit` in document order can be the
 * oldest. A repeated guid keeps its first occurrence.
 */
function newest(candidates: readonly Candidate[], limit: number): Candidate[] {
  const seen = new Set<string>();
  const ranked: { c: Candidate; i: number; t: number | undefined }[] = [];
  candidates.forEach((c, i) => {
    if (seen.has(c.guid)) return;
    seen.add(c.guid);
    ranked.push({ c, i, t: c.published ?? c.updated });
  });
  ranked.sort((a, b) => {
    if (a.t === undefined || b.t === undefined) {
      return a.t === b.t ? a.i - b.i : a.t === undefined ? 1 : -1;
    }
    return b.t - a.t || a.i - b.i;
  });
  return ranked.slice(0, limit).map((r) => r.c);
}

function insertChunks(candidates: Candidate[]): Candidate[][] {
  const encoder = new TextEncoder();
  const chunks: Candidate[][] = [];
  let chunk: Candidate[] = [];
  let bytes = 0;
  for (const c of candidates) {
    const size = encoder.encode(JSON.stringify(c)).byteLength;
    if (chunk.length && bytes + size > INSERT_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(c);
    bytes += size;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

interface PendingItem {
  feed_id: number;
  guid: string;
  url: string | null;
  title: string | null;
  summary: string | null;
  author: string | null;
  published_at: number | null;
  updated_at: number | null;
}

async function article(env: EngineEnv, itemId: number): Promise<void> {
  const db = env.DB;
  // Counting the attempt first also tells a repeated message apart: an item
  // that is no longer pending changes nothing and fetches nothing.
  const item = await db
    .prepare(
      `UPDATE item SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'
       RETURNING feed_id, guid, url, title, summary, author, published_at, updated_at`,
    )
    .bind(itemId)
    .first<PendingItem>();
  if (!item) return;

  const feed = await db
    .prepare("SELECT key, source, options FROM feed WHERE id = ?")
    .bind(item.feed_id)
    .first<{ key: string; source: string; options: string | null }>();
  if (!feed) throw new Error(`Item ${itemId} belongs to missing feed ${item.feed_id}`);
  const source = getSource(feed.source);
  if (!source.fetchArticle) throw new Error(`Source "${source.kind}" has no fetchArticle`);
  const options = parseOptions(source, feed.options === null ? undefined : JSON.parse(feed.options));

  const result = await source.fetchArticle(candidateOf(item), sourceContext(options, `item:${itemId}`));
  await db
    .prepare(
      `UPDATE item SET content = ?2, url = COALESCE(?3, url), title = COALESCE(?4, title),
         summary = COALESCE(?5, summary), author = COALESCE(?6, author),
         published_at = COALESCE(?7, published_at), updated_at = COALESCE(?8, updated_at), status = 'ok'
       WHERE id = ?1 AND status = 'pending'`,
    )
    .bind(
      itemId,
      result.content,
      result.url ?? null,
      result.title ?? null,
      result.summary ?? null,
      result.author ?? null,
      result.published ?? null,
      result.updated ?? null,
    )
    .run();
}

function candidateOf(item: PendingItem): Candidate {
  const c: Candidate = { guid: item.guid };
  if (item.url !== null) c.url = item.url;
  if (item.title !== null) c.title = item.title;
  if (item.summary !== null) c.summary = item.summary;
  if (item.author !== null) c.author = item.author;
  if (item.published_at !== null) c.published = item.published_at;
  if (item.updated_at !== null) c.updated = item.updated_at;
  return c;
}
