import { parseFeed } from "./feed-scan";
import type { DiscoverContext, FeedFetch, SourceContext } from "./source";

export const FEED_BYTE_CAP = 4 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5";

export function sourceFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  return fetch(input, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

export function sourceContext<Options>(options: Options, label: string): SourceContext<Options> {
  return { fetch: sourceFetch, options, log: (...data) => console.log(`[${label}]`, ...data) };
}

/**
 * Reads at most `cap` bytes of a decoded body in one or two `readAtLeast`
 * calls. `content-length` can't stand in for this: it is often missing and,
 * under gzip, is the compressed size.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader({ mode: "byob" });
  let buffer = new ArrayBuffer(cap);
  let length = 0;
  let done = false;
  while (length < cap) {
    const r = await reader.readAtLeast(cap - length, new Uint8Array(buffer, length, cap - length));
    if (r.value) {
      buffer = r.value.buffer as ArrayBuffer;
      length += r.value.byteLength;
    }
    if (r.done) {
      done = true;
      break;
    }
  }
  let truncated = false;
  if (!done) {
    truncated = !(await reader.read(new Uint8Array(1))).done;
    if (truncated) await reader.cancel();
  }
  return { text: new TextDecoder().decode(new Uint8Array(buffer, 0, length)), truncated };
}

interface Validators {
  etag: string | null;
  last_modified: string | null;
}

/**
 * The context for one discover run. Validator and state writes are collected
 * in `pending` and committed with the inserted items, so a run that fails
 * after a 200 doesn't leave validators behind that would turn the retry into
 * a 304 and lose the items.
 */
export function discoverContext(
  db: D1Database,
  feed: { id: number; key: string; state: string | null },
  options: unknown,
): { ctx: DiscoverContext<unknown, unknown>; pending: D1PreparedStatement[]; warnings: string[] } {
  const validatorWrites = new Map<string, D1PreparedStatement>();
  const warnings: string[] = [];
  let state: { value: unknown } | undefined;

  const fetchFeed = async (url: string): Promise<FeedFetch> => {
    const stored = await db
      .prepare("SELECT etag, last_modified FROM feed_url WHERE url = ?")
      .bind(url)
      .first<Validators>();
    const headers = new Headers({ accept: FEED_ACCEPT });
    if (stored?.etag) headers.set("if-none-match", stored.etag);
    if (stored?.last_modified) headers.set("if-modified-since", stored.last_modified);

    const res = await sourceFetch(url, { headers });
    if (res.status === 304) {
      await res.body?.cancel();
      return { notModified: true };
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`GET ${url}: HTTP ${res.status}`);
    }
    const { text, truncated } = await readCapped(res.body, FEED_BYTE_CAP);
    if (truncated) warnings.push(`${url} is over ${FEED_BYTE_CAP / 1024 / 1024} MB; only the first part was parsed`);

    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    if (etag !== (stored?.etag ?? null) || lastModified !== (stored?.last_modified ?? null)) {
      validatorWrites.set(
        url,
        db
          .prepare(
            `INSERT INTO feed_url (url, feed_id, etag, last_modified) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(url) DO UPDATE SET feed_id = excluded.feed_id, etag = excluded.etag, last_modified = excluded.last_modified`,
          )
          .bind(url, feed.id, etag, lastModified),
      );
    }
    return { notModified: false, text, truncated };
  };

  const ctx: DiscoverContext<unknown, unknown> = {
    ...sourceContext(options, `feed:${feed.key}`),
    fetchFeed,
    parseFeed,
    state: {
      get: () => (state ? state.value : feed.state === null ? undefined : JSON.parse(feed.state)),
      set: (value) => {
        state = { value };
      },
    },
  };

  return {
    ctx,
    warnings,
    get pending() {
      const writes = [...validatorWrites.values()];
      if (state) {
        writes.push(
          db.prepare("UPDATE feed SET state = ? WHERE id = ?").bind(JSON.stringify(state.value), feed.id),
        );
      }
      return writes;
    },
  };
}
