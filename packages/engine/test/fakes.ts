import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { Config, EngineEnv, EngineMessage, FeedEntry } from "../src/index";
import { createWorker, defineSource, syncConfig } from "../src/index";

export const engineEnv = env as unknown as EngineEnv;
export const db = env.DB;

interface FeedOptions {
  url: string;
}

function feedOptions(raw: unknown): FeedOptions {
  const url = (raw as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string") throw new Error("options.url must be a string");
  return { url };
}

function candidates(entries: FeedEntry[]) {
  return entries.map(({ id, ...rest }) => ({ guid: `fake-${id ?? rest.url}`, ...rest }));
}

/** Lists complete items from an RSS/Atom feed, like a generic feed source. */
export const feedSource = defineSource<FeedOptions>({
  apiVersion: 1,
  kind: "fake-feed",
  defaultSchedule: ["0 * * * *"],
  parseOptions: feedOptions,
  async discover(_feed, ctx) {
    const res = await ctx.fetchFeed(ctx.options.url);
    return res.notModified ? [] : candidates(ctx.parseFeed(res.text));
  },
});

/** Lists links from a feed and fetches each article page in its own invocation. */
export const articleSource = defineSource<FeedOptions>({
  apiVersion: 1,
  kind: "fake-article",
  defaultSchedule: ["30 * * * *"],
  parseOptions: feedOptions,
  async discover(_feed, ctx) {
    const res = await ctx.fetchFeed(ctx.options.url);
    return res.notModified ? [] : candidates(ctx.parseFeed(res.text));
  },
  async fetchArticle(candidate, ctx) {
    const res = await ctx.fetch(candidate.url!);
    if (!res.ok) throw new Error(`article HTTP ${res.status}`);
    return { content: await res.text() };
  },
});

export function testConfig(feeds: Config["feeds"]): Config {
  return {
    timezone: "Asia/Singapore",
    retention: { readDays: 30, unreadDays: 90, maxItems: 1000 },
    tombstoneDays: 365,
    feeds,
  };
}

export type Worker = ReturnType<typeof createWorker>;

/** Registers the fake sources, creates the feed rows and returns the handlers. */
export async function setup(config: Config): Promise<Worker> {
  const worker = createWorker({ sources: [feedSource, articleSource], config });
  await syncConfig(db, config, [feedSource.kind, articleSource.kind]);
  return worker;
}

export async function resetDb(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM item"),
    db.prepare("DELETE FROM feed_url"),
    db.prepare("DELETE FROM feed"),
    db.prepare("DELETE FROM meta"),
  ]);
}

export interface OriginRequest {
  url: string;
  headers: Record<string, string>;
}

type Route = (request: Request) => Response | Promise<Response>;

/**
 * Replaces `fetch` for the test and for objects (they share the isolate). A
 * Response has to be built inside the call: a body created in the test's
 * context can't be read from an object.
 */
export function fakeOrigin(routes: Record<string, Route>): OriginRequest[] {
  const requests: OriginRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: Object.fromEntries(request.headers) });
    const route = routes[request.url];
    return route ? route(request) : new Response("Not Found", { status: 404 });
  });
  return requests;
}

/** Records what is sent to the queue, so nothing reaches the real consumer mid-test. */
export function captureQueue(): MessageSendRequest<EngineMessage>[] {
  const sent: MessageSendRequest<EngineMessage>[] = [];
  vi.spyOn(engineEnv.QUEUE, "send").mockImplementation(async (body, options) => {
    sent.push({ body, ...options });
    return {} as QueueSendResponse;
  });
  vi.spyOn(engineEnv.QUEUE, "sendBatch").mockImplementation(async (messages) => {
    sent.push(...messages);
    return {} as QueueSendBatchResponse;
  });
  return sent;
}

let messageId = 0;

export type Outcome = { ack: true } | { retryDelaySeconds: number | undefined };

/**
 * Delivers one message to the worker's queue handler, as the queue would on
 * attempt `attempts`. `getQueueResult` doesn't report a retry's delay, so the
 * message's `retry` is watched directly.
 */
export async function deliver(worker: Worker, body: EngineMessage, attempts = 1): Promise<Outcome> {
  const batch = createMessageBatch<EngineMessage>("rss8", [
    { id: `m${++messageId}`, timestamp: new Date(), attempts, body },
  ]);
  const retry = vi.spyOn(batch.messages[0]!, "retry");
  const ctx = createExecutionContext();
  await worker.queue(batch, engineEnv);
  const result = await getQueueResult(batch, ctx);
  if (result.explicitAcks.length === 1 && result.retryMessages.length === 0) return { ack: true };
  if (result.retryMessages.length === 1 && result.explicitAcks.length === 0) {
    return { retryDelaySeconds: retry.mock.calls[0]?.[0]?.delaySeconds };
  }
  throw new Error(`unexpected queue result ${JSON.stringify(result)}`);
}

export async function feedId(key: string): Promise<number> {
  const id = await db.prepare("SELECT id FROM feed WHERE key = ?").bind(key).first<number>("id");
  if (id === null) throw new Error(`no feed ${key}`);
  return id;
}

export interface ItemRow {
  id: number;
  feed_id: number;
  guid: string;
  status: string;
  attempts: number;
  title: string | null;
  url: string | null;
  summary: string | null;
  content: string | null;
  published_at: number | null;
  crawled_at: number;
}

export async function items(): Promise<ItemRow[]> {
  const { results } = await db
    .prepare(
      "SELECT id, feed_id, guid, status, attempts, title, url, summary, content, published_at, crawled_at FROM item ORDER BY id",
    )
    .all<ItemRow>();
  return results;
}

export function rss(entries: { guid: string; title?: string; link?: string; pubDate?: string; body?: string }[]): string {
  const xml = entries
    .map(
      (e) =>
        `<item><guid>${e.guid}</guid>` +
        (e.title ? `<title>${e.title}</title>` : "") +
        (e.link ? `<link>${e.link}</link>` : "") +
        (e.pubDate ? `<pubDate>${e.pubDate}</pubDate>` : "") +
        (e.body ? `<description>${e.body}</description>` : "") +
        `</item>`,
    )
    .join("\n");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>\n${xml}\n</channel></rss>`;
}
