import { defineConfig } from "@rss8/engine";

export default defineConfig({
  // Feed schedules and the daily maintenance (05:15 local) use this time zone.
  timezone: "Europe/London",
  // Retention runs once a day. Ages count from when rss8 first fetched the
  // item, not its publish date. Starred items are never removed. A feed's own
  // `retention` overrides any of the three.
  retention: {
    readDays: 30, // remove read items older than this, and articles that failed to fetch
    unreadDays: 90, // remove unread items older than this
    maxItems: 1000, // keep at most this many non-starred items per feed, newest first
  },
  // A removed item leaves a tombstone (its id, no content), so a feed that
  // still lists an old post can't bring it back as new and unread.
  tombstoneDays: 365,
  feeds: [
    // rss8's own messages: a feed that starts failing or recovers, and a daily
    // health report. Required; its key and source must stay "system".
    // `enabled: false` stops the messages.
    { key: "system", source: "system", enabled: true, title: "rss8" },
    {
      key: "example-blog",
      source: "rss",
      enabled: true,
      title: "Example Blog",
      category: "Tech", // the folder in your reader; at most one per feed
      siteUrl: "https://blog.example.com/",
      options: { url: "https://blog.example.com/feed.xml" },
      schedule: ["10 * * * *"], // 5-field cron, in `timezone`; defaults to hourly
    },
    {
      key: "example-substack",
      source: "substack",
      enabled: false,
      title: "Example Newsletter",
      category: "Tech",
      siteUrl: "https://example.substack.com/",
      options: { url: "https://example.substack.com/feed" },
    },
  ],
});
