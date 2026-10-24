export interface FeedConfig {
  key: string;
  source: string;
  enabled: boolean;
  title?: string;
  siteUrl?: string;
  /** The folder clients show the feed in; none when absent. Feeds keep their config order within it. */
  category?: string;
  options?: unknown;
  /**
   * 5-field cron expressions, evaluated in `Config.timezone`. Defaults to the source's `defaultSchedule`.
   * They are checked on each tick of the deployment's cron trigger (`triggers.crons` in its Wrangler
   * config): the feed runs on the first tick at or after a matching minute, at most once per tick.
   */
  schedule?: string[];
  retention?: Partial<Retention>;
}

export interface Retention {
  readDays: number;
  unreadDays: number;
  maxItems: number;
}

export interface Config {
  /** IANA time zone for feed schedules and the daily maintenance run. */
  timezone: string;
  retention: Retention;
  tombstoneDays: number;
  feeds: FeedConfig[];
}

export function defineConfig(config: Config): Config {
  return config;
}
