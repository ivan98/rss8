// A plain RSS or Atom feed whose entries carry the whole article: one
// conditional fetch per run, and each item is stored complete (no fetchArticle).

import { defineSource, type Candidate, type DiscoverContext, type Feed } from "@rss8/engine";

export interface RssOptions {
  /** The feed's URL, http or https. */
  url: string;
}

export function parseRssOptions(raw: unknown): RssOptions {
  const url = (raw as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string" || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new Error("rss: options.url must be an http or https URL");
  }
  return { url };
}

/**
 * Each entry of the feed as a complete candidate, with the guid
 * `<kind>-<feed key>-<entry id, else link>`. Shared with sources that only add
 * a pass over each entry's content.
 */
export async function discoverEntries(
  kind: string,
  feed: Feed,
  ctx: DiscoverContext<RssOptions, unknown>,
): Promise<Candidate[]> {
  const res = await ctx.fetchFeed(ctx.options.url);
  if (res.notModified) return [];
  const candidates: Candidate[] = [];
  for (const { id, url, title, summary, content, author, published, updated } of ctx.parseFeed(res.text)) {
    const native = id ?? url;
    if (!native) continue;
    // Two feeds may carry the same entry, so the guid also names the feed.
    candidates.push({ guid: `${kind}-${feed.key}-${native}`, url, title, summary, content, author, published, updated });
  }
  return candidates;
}

export default defineSource<RssOptions>({
  apiVersion: 1,
  kind: "rss",
  defaultSchedule: ["0 * * * *"],
  parseOptions: parseRssOptions,
  discover: (feed, ctx) => discoverEntries("rss", feed, ctx),
});
