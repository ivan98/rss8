// A Substack publication's feed. Like `rss`, each entry is stored complete with
// no page fetch; the entry's HTML is first reduced from Substack's page markup
// to plain article HTML (see clean.ts).

import { defineSource } from "@rss8/engine";
import { discoverEntries, parseRssOptions, type RssOptions } from "@rss8/source-rss";
import { cleanSubstack } from "./clean";

export { cleanSubstack };

export default defineSource<RssOptions>({
  apiVersion: 1,
  kind: "substack",
  defaultSchedule: ["0 * * * *"],
  parseOptions: parseRssOptions,

  async discover(feed, ctx) {
    const candidates = await discoverEntries("substack", feed, ctx);
    for (const candidate of candidates) {
      if (candidate.content) candidate.content = await cleanSubstack(candidate.content, candidate.url);
    }
    return candidates;
  },
});
