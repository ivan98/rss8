import { exports } from "cloudflare:workers";
import { db } from "./fakes";

/** Matches the API_PASSWORD binding in vitest.config.ts. */
export const PASSWORD = "test-password";

export const READING_LIST = "user/-/state/com.google/reading-list";
export const READ = "user/-/state/com.google/read";
export const STARRED = "user/-/state/com.google/starred";

/** A request through the deployment's Worker, which forwards it to the Api object. */
export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`https://rss8.test${path}`, init);
}

export function formBody(fields: [string, string][]): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

export async function login(user = "test", passwd = PASSWORD): Promise<string> {
  const res = await call("/api/greader.php/accounts/ClientLogin", formBody([["Email", user], ["Passwd", passwd]]));
  const auth = /^Auth=(.+)$/m.exec(await res.text())?.[1];
  if (res.status !== 200 || !auth) throw new Error(`login failed: ${res.status}`);
  return auth;
}

/** A client logged in once, sending its token on every call. */
export class Client {
  constructor(
    readonly auth: string,
    readonly prefix = "/api/greader.php",
  ) {}

  static async login(prefix?: string): Promise<Client> {
    return new Client(await login(), prefix);
  }

  get(path: string, query: [string, string][] = []): Promise<Response> {
    const qs = query.length ? `?${new URLSearchParams(query)}` : "";
    return call(`${this.prefix}/reader/api/0/${path}${qs}`, { headers: { Authorization: `GoogleLogin auth=${this.auth}` } });
  }

  post(path: string, fields: [string, string][]): Promise<Response> {
    const init = formBody(fields);
    return call(`${this.prefix}/reader/api/0/${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `GoogleLogin auth=${this.auth}` },
    });
  }

  async ids(query: [string, string][]): Promise<{ ids: number[]; continuation?: string }> {
    const res = await this.get("stream/items/ids", [["output", "json"], ...query]);
    if (res.status !== 200) throw new Error(`ids ${res.status}: ${await res.text()}`);
    const body = await res.json<{ itemRefs: { id: string }[]; continuation?: string }>();
    return { ids: body.itemRefs.map((r) => Number(r.id)), continuation: body.continuation };
  }

  async contents(ids: string[]): Promise<ContentItem[]> {
    const res = await this.post("stream/items/contents", ids.map((i) => ["i", i]));
    if (res.status !== 200) throw new Error(`contents ${res.status}`);
    return (await res.json<{ items: ContentItem[] }>()).items;
  }

  async editTag(fields: [string, string][]): Promise<Response> {
    return this.post("edit-tag", fields);
  }
}

export interface ContentItem {
  id: string;
  title: string;
  categories: string[];
  crawlTimeMsec: string;
  origin: { streamId: string; title: string };
  summary: { content: string };
}

export interface SeedItem {
  id: number;
  feedId?: number;
  crawledAt: number;
  status?: "pending" | "ok" | "error" | "purged";
  read?: boolean;
  starred?: boolean;
}

export async function seed(items: SeedItem[], feeds = [1, 2]): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM item"),
    db.prepare("DELETE FROM feed_url"),
    db.prepare("DELETE FROM feed"),
    ...feeds.map((id) =>
      db
        .prepare("INSERT INTO feed (id, key, source, title, site_url) VALUES (?1, ?2, 'example', ?3, ?4)")
        .bind(id, `feed-${id}`, `Feed ${id}`, `https://example.com/${id}`),
    ),
    db
      .prepare(
        `INSERT INTO item (id, feed_id, guid, status, title, url, content, crawled_at, is_read, is_starred)
         SELECT value ->> 'id', value ->> 'feedId', 'example-' || (value ->> 'id'), value ->> 'status',
                'Item ' || (value ->> 'id'), 'https://example.com/item/' || (value ->> 'id'),
                '<p>Body of ' || (value ->> 'id') || '</p>', value ->> 'crawledAt', value ->> 'read', value ->> 'starred'
         FROM json_each(?1)`,
      )
      .bind(
        JSON.stringify(
          items.map((i) => ({
            id: i.id,
            feedId: i.feedId ?? feeds[0],
            crawledAt: i.crawledAt,
            status: i.status ?? "ok",
            read: i.read ? 1 : 0,
            starred: i.starred ? 1 : 0,
          })),
        ),
      ),
  ]);
}

export async function state(): Promise<{ read: number[]; starred: number[] }> {
  const { results } = await db
    .prepare("SELECT id, is_read, is_starred FROM item WHERE status = 'ok' ORDER BY id")
    .all<{ id: number; is_read: number; is_starred: number }>();
  return {
    read: results.filter((r) => r.is_read).map((r) => r.id),
    starred: results.filter((r) => r.is_starred).map((r) => r.id),
  };
}

export const hex16 = (id: number) => id.toString(16).padStart(16, "0");
