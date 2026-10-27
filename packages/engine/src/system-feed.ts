import type { Config } from "./config";
import type { MaintenanceReport } from "./maintenance";
import { defineSource } from "./source";

/** The key and source kind of the feed the engine posts its own messages to. */
export const SYSTEM = "system";

/** Registered by `createWorker`. The engine writes the feed's items itself; it has nothing to discover. */
export const systemSource = defineSource({
  apiVersion: 1,
  kind: SYSTEM,
  defaultSchedule: [],
  discover: async () => [],
});

export interface FeedRef {
  key: string;
  title: string;
  siteUrl: string | null;
}

export type SystemMessage =
  | { type: "feed-failing"; feed: FeedRef; since: number; error: string }
  | { type: "feed-recovered"; feed: FeedRef; since: number; now: number }
  | { type: "maintenance-failed"; date: string; error: string }
  | { type: "daily"; date: string; report: DailyReport };

export interface FeedHealth {
  title: string;
  enabled: boolean;
  lastFetchedAt: number | null;
  lastError: string | null;
  failingSince: number | null;
  /** Items crawled in the last 24 hours, and how many of them ended in `error`. */
  added: number;
  errors: number;
}

export interface DailyReport {
  timezone: string;
  feeds: FeedHealth[];
  library: { total: number; unread: number; starred: number };
  maintenance: MaintenanceReport;
  sizeBytes: number;
  version: string | null;
}

const D1_LIMIT_BYTES = 500_000_000;

/**
 * The statement that posts one message to the system feed, as an `ok` item,
 * for a caller to run alone or inside its own batch. It inserts nothing when
 * the feed is disabled. The guid is derived from the message, so posting the
 * same message twice (a redelivered queue message) stores it once.
 */
export function systemMessageInsert(db: D1Database, message: SystemMessage, now: number): D1PreparedStatement {
  const { guid, title, url, content } = render(message);
  return db
    .prepare(
      `INSERT OR IGNORE INTO item (feed_id, guid, status, url, title, content, published_at, crawled_at)
       SELECT id, ?1, 'ok', ?2, ?3, ?4, ?5, MAX(?6, COALESCE((SELECT MAX(crawled_at) FROM item), 0))
       FROM feed WHERE key = '${SYSTEM}' AND source = '${SYSTEM}' AND enabled = 1 AND archived_at IS NULL`,
    )
    .bind(guid, url, title, content, Math.floor(now / 1000), now);
}

/** Posts a message on its own. A failure is logged, not thrown: a message must never fail the work it reports on. */
export async function postSystemMessage(db: D1Database, message: SystemMessage, now: number): Promise<void> {
  try {
    await systemMessageInsert(db, message, now).run();
  } catch (error) {
    console.error(`system feed: ${message.type} not posted:`, error);
  }
}

/** Reads the numbers for the daily message: 3 queries, about one row per item kept plus a day's new items. */
export async function dailyReport(
  db: D1Database,
  config: Config,
  now: number,
  maintenance: MaintenanceReport,
  version: string | null,
): Promise<DailyReport> {
  const [feeds, added, library] = await db.batch<Record<string, number | string | null>>([
    db.prepare(
      `SELECT id, title, enabled, last_fetched_at, last_error, failing_since FROM feed
       WHERE archived_at IS NULL AND source != '${SYSTEM}' ORDER BY position`,
    ),
    db
      .prepare(
        `SELECT feed_id, count(*) AS added, sum(status = 'error') AS errors FROM item
         WHERE id >= (SELECT id FROM item WHERE crawled_at >= ? ORDER BY crawled_at LIMIT 1) AND status != 'purged'
         GROUP BY feed_id`,
      )
      .bind(now - 86_400_000),
    db.prepare(
      `SELECT count(*) AS total, sum(is_read = 0) AS unread, sum(is_starred) AS starred FROM item
       WHERE status = 'ok' AND feed_id != (SELECT id FROM feed WHERE key = '${SYSTEM}')`,
    ),
  ]);
  const counts = new Map(added!.results.map((r) => [r.feed_id, r]));
  const totals = library!.results[0]!;
  return {
    timezone: config.timezone,
    feeds: feeds!.results.map((f) => ({
      title: f.title as string,
      enabled: f.enabled === 1,
      lastFetchedAt: f.last_fetched_at as number | null,
      lastError: f.last_error as string | null,
      failingSince: f.failing_since as number | null,
      added: Number(counts.get(f.id)?.added ?? 0),
      errors: Number(counts.get(f.id)?.errors ?? 0),
    })),
    library: { total: Number(totals.total), unread: Number(totals.unread ?? 0), starred: Number(totals.starred ?? 0) },
    maintenance,
    sizeBytes: library!.meta.size_after,
    version,
  };
}

function render(message: SystemMessage): { guid: string; title: string; url: string | null; content: string } {
  switch (message.type) {
    case "feed-failing":
      return {
        guid: `${SYSTEM}:feed-failing:${message.feed.key}:${message.since}`,
        title: `${message.feed.title} is failing`,
        url: message.feed.siteUrl,
        content: `<p>${esc(message.feed.title)} stopped fetching: <code>${esc(message.error)}</code></p>
<p>It tries again at its next scheduled time. A message follows when it recovers, and the daily report lists it until then.</p>`,
      };
    case "feed-recovered":
      return {
        guid: `${SYSTEM}:feed-recovered:${message.feed.key}:${message.since}`,
        title: `${message.feed.title} recovered`,
        url: message.feed.siteUrl,
        content: `<p>${esc(message.feed.title)} is fetching again after failing for ${duration(message.now - message.since)}.</p>`,
      };
    case "maintenance-failed":
      return {
        guid: `${SYSTEM}:maintenance-failed:${message.date}`,
        title: `Maintenance for ${message.date} failed`,
        url: null,
        content: `<p>The daily maintenance run failed after its retries: <code>${esc(message.error)}</code></p>
<p>Retention and the daily report wait for the next local day's run.</p>`,
      };
    case "daily":
      return {
        guid: `${SYSTEM}:daily:${message.date}`,
        title: dailyTitle(message.report),
        url: null,
        content: dailyContent(message.report),
      };
  }
}

/** An enabled feed needs attention when it is failing, retrying or carries a warning. */
function feedStatus(feed: FeedHealth, timezone: string): { attention: boolean; text: string } {
  if (!feed.enabled) return { attention: false, text: "disabled" };
  if (feed.failingSince !== null) {
    return { attention: true, text: `failing since ${localTime(feed.failingSince, timezone)}: ${feed.lastError ?? ""}` };
  }
  if (feed.lastError !== null) return { attention: true, text: feed.lastError };
  return { attention: false, text: "ok" };
}

function dailyTitle(report: DailyReport): string {
  const attention = report.feeds.filter((f) => feedStatus(f, report.timezone).attention).length;
  const storage = report.maintenance.warning ? "; storage warning" : "";
  if (attention === 0) return `rss8 daily: all ${report.feeds.length} feeds healthy${storage}`;
  return `rss8 daily: ${attention} of ${report.feeds.length} feeds need attention${storage}`;
}

/**
 * Table markup that both clients draw with borders and aligned columns, found
 * by testing variants on the devices. Unread drops inline styles but honours
 * the table and cell attributes. Reeder ignores those attributes, drops all
 * styling on `td`, overrides `th` borders unless `!important`, and lays out
 * each row as its own table, so every cell is a `th` and every column but the
 * last has a fixed width. Borders go on the right and bottom only (plus the
 * outer edges) so adjacent cells don't draw double lines.
 */
const COLUMNS = [
  { title: "Feed", em: 7, align: "left" },
  { title: "New", em: 3, align: "right" },
  { title: "Last fetched", em: 6.5, align: "left" },
  { title: "Status", em: 5.5, align: "left" },
] as const;

function tableCell(column: number, header: boolean, html: string): string {
  const { em, align } = COLUMNS[column]!;
  const line = "1px solid #888 !important";
  const style = [
    "border: 0 !important",
    `border-right: ${line}`,
    `border-bottom: ${line}`,
    column === 0 ? `border-left: ${line}` : "",
    header ? `border-top: ${line}` : "",
    "padding: 4px 6px !important",
    `text-align: ${align} !important`,
    "vertical-align: top !important",
    `font-weight: ${header ? "bold" : "normal"} !important`,
    "overflow-wrap: anywhere !important",
    // The last column may grow, so a long error doesn't become a narrow strip; the ones before it set the alignment.
    column === COLUMNS.length - 1 ? `min-width: ${em}em !important` : `width: ${em}em !important; min-width: ${em}em !important; max-width: ${em}em !important`,
  ].filter(Boolean);
  return `<th align="${align}" valign="top" style="${style.join("; ")}">${html}</th>`;
}

/** Rows run newest fetch first (to the minute, as shown), then most new items; feeds never fetched go last. */
export function dailyContent(report: DailyReport): string {
  const tz = report.timezone;
  const minute = (f: FeedHealth) => (f.lastFetchedAt === null ? -1 : Math.floor(f.lastFetchedAt / 60_000));
  const feeds = [...report.feeds].sort((a, b) => minute(b) - minute(a) || b.added - a.added);
  const row = (cells: string[], header = false) => `<tr>${cells.map((c, i) => tableCell(i, header, c)).join("")}</tr>`;
  const rows = feeds.map((f) => {
    const status = feedStatus(f, tz);
    const fetched = f.lastFetchedAt === null ? "never" : localTime(f.lastFetchedAt, tz);
    const text = status.attention ? `<strong>${esc(status.text)}</strong>` : esc(status.text);
    const errors = f.errors ? `; ${f.errors} article errors` : "";
    return row([esc(f.title), String(f.added), fetched, text + errors]);
  });
  const { library, maintenance } = report;
  const newTotal = report.feeds.reduce((sum, f) => sum + f.added, 0);
  return `<h3>Feeds, last 24 hours</h3>
<table border="1" cellpadding="4" cellspacing="0">
${row(COLUMNS.map((c) => c.title), true)}
${rows.join("\n")}
</table>
<p><strong>Library:</strong> ${count(library.total)} articles kept (${count(library.unread)} unread, ${count(library.starred)} starred); ${count(newTotal)} new in 24 hours.</p>
<p><strong>Maintenance:</strong> ${count(maintenance.tombstoned)} articles expired, ${count(maintenance.deleted)} old tombstones deleted, ${count(maintenance.erred)} stuck articles marked as errors.</p>
<p><strong>Storage:</strong> ${Math.round(report.sizeBytes / 1_000_000)} MB of ${D1_LIMIT_BYTES / 1_000_000} MB${maintenance.warning ? `. <strong>${esc(maintenance.warning)}</strong>` : ""}</p>
<p><strong>Version:</strong> ${esc(report.version ?? "unknown")}</p>`;
}

function localTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
