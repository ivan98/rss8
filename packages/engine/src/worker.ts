import type { Config } from "./config";
import { syncConfig } from "./config-sync";
import { consume } from "./consumer";
import { isDue, parseCron, tickWindow, type CronSchedule } from "./cron";
import type { EngineEnv } from "./env";
import { runMaintenance } from "./maintenance";
import { sendAll } from "./messages";
import { parseOptions, registerSources, type AnySource } from "./source";

/** The cron trigger's interval; the Wrangler trigger is `0,15,30,45 * * * *`. */
export const TICK_MINUTES = 15;
export const MAINTENANCE_SCHEDULE = "15 5 * * *";

export function createWorker({ sources, config }: { sources: readonly AnySource[]; config: Config }) {
  registerSources(sources);
  const schedules = feedSchedules(sources, config);
  const kinds = sources.map((s) => s.kind);
  const maintenance = [parseCron(MAINTENANCE_SCHEDULE)];

  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/health") return new Response("OK");
      return new Response("Not Found", { status: 404 });
    },

    async scheduled(controller: ScheduledController, env: EngineEnv): Promise<void> {
      await syncConfig(env.DB, config, kinds);
      const window = tickWindow(config.timezone, controller.scheduledTime, TICK_MINUTES);
      const { results } = await env.DB.prepare(
        "SELECT id, key FROM feed WHERE enabled = 1 AND archived_at IS NULL",
      ).all<{ id: number; key: string }>();
      await sendAll(
        env.QUEUE,
        results
          .filter((feed) => isDue(schedules.get(feed.key) ?? [], window))
          .map((feed) => ({ body: { type: "discover", feedId: feed.id } })),
      );
      if (isDue(maintenance, window)) {
        const report = await runMaintenance(env.DB, config, controller.scheduledTime);
        console.log("maintenance", JSON.stringify(report));
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
