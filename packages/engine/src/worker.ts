import type { Config } from "./config";
import { syncConfig } from "./config-sync";
import { consume } from "./consumer";
import { isDue, localMinute, localMinutes, parseCron, type CronSchedule, type LocalMinute } from "./cron";
import type { EngineEnv } from "./env";
import { runMaintenance } from "./maintenance";
import { sendAll } from "./messages";
import { parseOptions, registerSources, type AnySource } from "./source";

/** The cron trigger's interval; the Wrangler trigger is `0,15,30,45 * * * *`. */
export const TICK_MINUTES = 15;
/** Maintenance runs once a local day, on the first tick at or after this time in `config.timezone`. */
export const MAINTENANCE_LOCAL_TIME = { hour: 5, minute: 15 } as const;
/** After a longer outage a feed only needs to run once to catch up. */
const MAX_CATCH_UP_MS = 24 * 3_600_000;

export function createWorker({ sources, config }: { sources: readonly AnySource[]; config: Config }) {
  registerSources(sources);
  const schedules = feedSchedules(sources, config);
  const kinds = sources.map((s) => s.kind);

  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/health") return new Response("OK");
      return new Response("Not Found", { status: 404 });
    },

    async scheduled(controller: ScheduledController, env: EngineEnv): Promise<void> {
      await syncConfig(env.DB, config, kinds);
      const tick = controller.scheduledTime;
      const { lastTick, maintenanceDate } = await readTickState(env.DB);
      if (lastTick !== undefined && tick <= lastTick) return;

      const after = Math.max(lastTick ?? tick - TICK_MINUTES * 60_000, tick - MAX_CATCH_UP_MS);
      const window = localMinutes(config.timezone, after, tick);
      const { results } = await env.DB.prepare(
        "SELECT id, key FROM feed WHERE enabled = 1 AND archived_at IS NULL",
      ).all<{ id: number; key: string }>();
      await sendAll(
        env.QUEUE,
        results
          .filter((feed) => isDue(schedules.get(feed.key) ?? [], window))
          .map((feed) => ({ body: { type: "discover", feedId: feed.id } })),
      );
      await env.DB.prepare(STORE_LAST_TICK).bind(String(tick)).run();

      const now = localMinute(config.timezone, tick);
      const today = localDate(now);
      if (today !== maintenanceDate && minuteOfDay(now) >= minuteOfDay(MAINTENANCE_LOCAL_TIME)) {
        const report = await runMaintenance(env.DB, config, tick);
        console.log("maintenance", JSON.stringify(report));
        await env.DB.prepare(STORE_MAINTENANCE_DATE).bind(today).run();
      }
    },

    async queue(batch: MessageBatch, env: EngineEnv): Promise<void> {
      await consume(batch, env);
    },
  } satisfies ExportedHandler<EngineEnv>;
}

/** Checks every feed against its source when the deployment loads, so a bad config fails fast. */
function feedSchedules(sources: readonly AnySource[], config: Config): Map<string, CronSchedule[]> {
  const byKind = new Map(sources.map((s) => [s.kind, s]));
  const schedules = new Map<string, CronSchedule[]>();
  for (const feed of config.feeds) {
    const source = byKind.get(feed.source);
    if (!source) throw new Error(`Feed "${feed.key}" uses unknown source "${feed.source}"`);
    parseOptions(source, feed.options);
    schedules.set(feed.key, (feed.schedule ?? source.defaultSchedule).map(parseCron));
  }
  return schedules;
}

async function readTickState(db: D1Database): Promise<{ lastTick?: number; maintenanceDate?: string }> {
  const { results } = await db
    .prepare("SELECT key, value FROM meta WHERE key IN ('last_tick', 'maintenance_date')")
    .all<{ key: string; value: string }>();
  const values = new Map(results.map((r) => [r.key, r.value]));
  const lastTick = values.get("last_tick");
  return {
    lastTick: lastTick === undefined ? undefined : Number(lastTick),
    maintenanceDate: values.get("maintenance_date"),
  };
}

// `meta.value` is TEXT, so the comparison must be numeric or "999" would beat "1000".
const STORE_LAST_TICK = `
INSERT INTO meta (key, value) VALUES ('last_tick', ?1)
ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`;

const STORE_MAINTENANCE_DATE = `
INSERT INTO meta (key, value) VALUES ('maintenance_date', ?1)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

function localDate(t: LocalMinute): string {
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.dayOfMonth).padStart(2, "0")}`;
}

function minuteOfDay(t: { hour: number; minute: number }): number {
  return t.hour * 60 + t.minute;
}
