// Daily retention (design §5). Every statement ranges over item_retain or
// item_unsettled from an id bound, so it reads a fixed number of rows per row
// it changes plus a few per feed. The steps run in priority order and share
// one budget of changed rows; the next run continues where a run stops.
//
// `status = 'ok'`, `status != 'ok'` and `is_starred = 0` stay literals: a bound
// parameter would stop SQLite from matching the partial indexes.

import type { Config, Retention } from "./config";

export interface MaintenanceReport {
  tombstoned: number;
  deleted: number;
  erred: number;
  warning?: string;
}

export interface MaintenanceLimits {
  maxChanges: number;
  storageGuardBytes: number;
}

export const MAINTENANCE_LIMITS: MaintenanceLimits = {
  maxChanges: 2_000,
  storageGuardBytes: 400_000_000,
};

const DAY_MS = 86_400_000;
const PENDING_MS = DAY_MS;

// When every item is older than the cutoff the lookup finds nothing, and every
// item must fall below the bound. A bare NULL would match none.
const MAX_ID = "9223372036854775807";
const idBound = (cutoffMs: string) =>
  `COALESCE((SELECT id FROM item WHERE crawled_at >= ${cutoffMs} ORDER BY crawled_at LIMIT 1), ${MAX_ID})`;

const tombstone = (select: string) =>
  `UPDATE item SET status = 'purged', title = NULL, summary = NULL, content = NULL, author = NULL, url = NULL
  WHERE id IN (${select})`;

// The final parameter of every statement is the remaining budget. In the
// per-feed statements ?1 is JSON: feed ids, or {"feed": id, "cutoff": epoch ms}.
export const maintenanceSql = {
  archivedOk: tombstone(`
    SELECT i.id FROM json_each(?1) AS f CROSS JOIN item AS i
    WHERE i.feed_id = f.value AND i.status = 'ok' AND i.is_starred = 0
    LIMIT ?2`),

  archivedUnsettled: tombstone(`
    SELECT i.id FROM json_each(?1) AS f CROSS JOIN item AS i
    WHERE i.status != 'ok' AND i.status IN ('pending', 'error') AND i.feed_id = f.value
      AND i.is_starred = 0
    LIMIT ?2`),

  // ?1 holds the feeds that share one maxItems, ?2. A LIMIT or OFFSET can't
  // refer to the outer row, so feeds with other values need their own run.
  // MATERIALIZED computes each feed's bound once.
  maxItems: tombstone(`
    WITH f AS MATERIALIZED (
      SELECT value AS feed_id,
             (SELECT id FROM item
              WHERE status = 'ok' AND feed_id = value AND is_starred = 0
              ORDER BY id DESC LIMIT 1 OFFSET ?2) AS bound
      FROM json_each(?1))
    SELECT i.id FROM f CROSS JOIN item AS i
    WHERE i.feed_id = f.feed_id AND i.is_read IN (0, 1) AND i.id <= f.bound
      AND i.status = 'ok' AND i.is_starred = 0
    LIMIT ?3`),

  unreadAge: ageRule(0),
  readAge: ageRule(1),

  // Across all feeds, oldest first, on item_unread.
  storageGuard: tombstone(`
    SELECT id FROM item
    WHERE status = 'ok' AND is_read = 0 AND is_starred = 0
    ORDER BY id
    LIMIT ?1`),

  // ?2 is one cutoff for every feed in ?1.
  pendingToError: `
    UPDATE item SET status = 'error' WHERE id IN (
      SELECT i.id FROM json_each(?1) AS f CROSS JOIN item AS i
      WHERE i.status != 'ok' AND i.status = 'pending' AND i.feed_id = f.value
        AND i.id < ${idBound("?2")} AND i.is_starred = 0
      LIMIT ?3)`,

  errorAge: tombstone(`
    SELECT i.id FROM json_each(?1) AS f CROSS JOIN item AS i
    WHERE i.status != 'ok' AND i.status = 'error' AND i.feed_id = f.value ->> 'feed'
      AND i.id < ${idBound("f.value ->> 'cutoff'")} AND i.is_starred = 0
    LIMIT ?2`),

  purgeTombstones: `
    DELETE FROM item WHERE id IN (
      SELECT i.id FROM json_each(?1) AS f CROSS JOIN item AS i
      WHERE i.status != 'ok' AND i.status = 'purged' AND i.feed_id = f.value
        AND i.id < ${idBound("?2")} AND i.is_starred = 0
      LIMIT ?3)`,
};

function ageRule(isRead: 0 | 1): string {
  return tombstone(`
    SELECT i.id FROM json_each(?1) AS f CROSS JOIN item AS i
    WHERE i.feed_id = f.value ->> 'feed' AND i.is_read = ${isRead}
      AND i.id < ${idBound("f.value ->> 'cutoff'")}
      AND i.status = 'ok' AND i.is_starred = 0
    LIMIT ?2`);
}

interface FeedRow {
  id: number;
  key: string;
  archived_at: number | null;
}

interface FeedPolicy {
  id: number;
  retention: Retention;
}

interface Step {
  counter: "tombstoned" | "deleted" | "erred";
  sql: string;
  params: unknown[];
}

export async function runMaintenance(
  db: D1Database,
  config: Config,
  now: number,
  limits: MaintenanceLimits = MAINTENANCE_LIMITS,
): Promise<MaintenanceReport> {
  const feeds = await db.prepare("SELECT id, key, archived_at FROM feed").all<FeedRow>();
  const { live, archived } = policies(feeds.results, config);

  const report: MaintenanceReport = { tombstoned: 0, deleted: 0, erred: 0 };
  let budget = limits.maxChanges;
  let sizeBytes = feeds.meta.size_after;

  const run = async (step: Step) => {
    if (budget <= 0) return;
    const result = await db.prepare(step.sql).bind(...step.params, budget).run();
    report[step.counter] += result.meta.changes;
    budget -= result.meta.changes;
    sizeBytes = result.meta.size_after;
  };

  // Most important first, since a backlog can use up the budget. A removed
  // feed and a flooding feed come first, then unread before read: unread ids
  // are in every sync's unread set, old read ids in none. Then the storage
  // guard, which goes beyond the settings only with what they left over.
  // Housekeeping that clients never see goes last.
  if (archived.length > 0) {
    const ids = JSON.stringify(archived);
    await run({ counter: "tombstoned", sql: maintenanceSql.archivedOk, params: [ids] });
    await run({ counter: "tombstoned", sql: maintenanceSql.archivedUnsettled, params: [ids] });
  }
  for (const [maxItems, group] of Map.groupBy(live, (feed) => feed.retention.maxItems)) {
    const ids = JSON.stringify(group.map((feed) => feed.id));
    await run({ counter: "tombstoned", sql: maintenanceSql.maxItems, params: [ids, maxItems] });
  }
  const liveIds = JSON.stringify(live.map((feed) => feed.id));
  if (live.length > 0) {
    const unread = cutoffs(live, now, (r) => r.unreadDays);
    await run({ counter: "tombstoned", sql: maintenanceSql.unreadAge, params: [unread] });
    const read = cutoffs(live, now, (r) => r.readDays);
    await run({ counter: "tombstoned", sql: maintenanceSql.readAge, params: [read] });
  }

  if (sizeBytes > limits.storageGuardBytes) {
    report.warning =
      `Database is ${megabytes(sizeBytes)} MB, above the ${megabytes(limits.storageGuardBytes)} MB ` +
      "storage guard: tombstoning the oldest unread items early";
    await run({ counter: "tombstoned", sql: maintenanceSql.storageGuard, params: [] });
  }

  if (live.length > 0) {
    await run({ counter: "erred", sql: maintenanceSql.pendingToError, params: [liveIds, now - PENDING_MS] });
    const errors = cutoffs(live, now, (r) => r.readDays);
    await run({ counter: "tombstoned", sql: maintenanceSql.errorAge, params: [errors] });
  }
  if (feeds.results.length > 0) {
    const allIds = JSON.stringify(feeds.results.map((feed) => feed.id));
    const cutoff = now - config.tombstoneDays * DAY_MS;
    await run({ counter: "deleted", sql: maintenanceSql.purgeTombstones, params: [allIds, cutoff] });
  }

  return report;
}

// A feed in D1 with no config entry is archived, or about to be at the next
// config sync; either way the defaults apply.
function policies(rows: FeedRow[], config: Config): { live: FeedPolicy[]; archived: number[] } {
  const overrides = new Map(config.feeds.map((feed) => [feed.key, feed.retention]));
  const live: FeedPolicy[] = [];
  const archived: number[] = [];
  for (const row of rows) {
    if (row.archived_at !== null) {
      archived.push(row.id);
      continue;
    }
    const own = overrides.get(row.key);
    const defaults = config.retention;
    live.push({
      id: row.id,
      retention: {
        readDays: own?.readDays ?? defaults.readDays,
        unreadDays: own?.unreadDays ?? defaults.unreadDays,
        maxItems: own?.maxItems ?? defaults.maxItems,
      },
    });
  }
  return { live, archived };
}

function cutoffs(feeds: FeedPolicy[], now: number, days: (r: Retention) => number): string {
  return JSON.stringify(feeds.map((feed) => ({ feed: feed.id, cutoff: now - days(feed.retention) * DAY_MS })));
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}
