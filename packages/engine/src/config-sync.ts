import type { Config } from "./config";

export async function syncConfig(
  db: D1Database,
  config: Config,
  sourceKinds: readonly string[],
): Promise<void> {
  assertValidConfig(config, sourceKinds);

  const hash = await sha256Hex(JSON.stringify(config));
  const stored = await db
    .prepare("SELECT value FROM meta WHERE key = 'config_hash'")
    .first<string>("value");
  if (stored === hash) return;

  const now = Date.now();
  await db.batch([
    ...config.feeds.map((feed, position) =>
      db.prepare(UPSERT_FEED).bind(
        feed.key,
        feed.source,
        feed.options === undefined ? null : JSON.stringify(feed.options),
        feed.enabled ? 1 : 0,
        feed.title ?? feed.key,
        feed.siteUrl ?? null,
        feed.category ?? null,
        position,
      ),
    ),
    db.prepare(ARCHIVE_REMOVED).bind(now, JSON.stringify(config.feeds.map((feed) => feed.key))),
    db.prepare(STORE_HASH).bind(hash),
  ]);
}

const UPSERT_FEED = `
INSERT INTO feed (key, source, options, enabled, title, site_url, category, position, archived_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)
ON CONFLICT(key) DO UPDATE SET
  state = CASE WHEN feed.source = excluded.source THEN feed.state ELSE NULL END,
  source = excluded.source,
  options = excluded.options,
  enabled = excluded.enabled,
  title = excluded.title,
  site_url = excluded.site_url,
  category = excluded.category,
  position = excluded.position,
  archived_at = NULL`;

const ARCHIVE_REMOVED = `
UPDATE feed SET archived_at = ?1
WHERE archived_at IS NULL AND key NOT IN (SELECT value FROM json_each(?2))`;

const STORE_HASH = `
INSERT INTO meta (key, value) VALUES ('config_hash', ?1)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

export function assertValidConfig(config: Config, sourceKinds: readonly string[]): void {
  const known = new Set(sourceKinds);
  const seen = new Set<string>();
  for (const feed of config.feeds) {
    if (seen.has(feed.key)) throw new Error(`Duplicate feed key "${feed.key}" in config`);
    seen.add(feed.key);
    if (!known.has(feed.source)) {
      throw new Error(`Feed "${feed.key}" uses unknown source "${feed.source}"`);
    }
    const { category } = feed;
    // The name is part of the stream id user/-/label/<name>.
    if (category !== undefined && (category !== category.trim() || !/^[^/]{1,64}$/.test(category))) {
      throw new Error(`Feed "${feed.key}" has category "${category}"; use 1 to 64 characters, no "/", no outer spaces`);
    }
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
