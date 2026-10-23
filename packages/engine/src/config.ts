export interface FeedConfig {
  key: string;
  source: string;
  enabled: boolean;
  title?: string;
  siteUrl?: string;
  options?: unknown;
  /** 5-field cron expressions, evaluated in `Config.timezone`. Defaults to the source's `defaultSchedule`. */
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
