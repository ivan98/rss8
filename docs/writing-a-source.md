# Writing a source

A source is how rss8 reads one kind of site. The built-in `rss` and `substack` sources cover feeds that carry whole articles. You write your own when a feed sends only teasers, needs cleaning, or isn't a feed at all. Adding a source never needs engine or schema changes.

Before writing one, check whether an existing source fits: a feed whose entries already hold the full article needs only a config entry with `source: "rss"`.

## The two shapes

1. **Feed-complete:** `discover` returns each item with its `content`, and there's no `fetchArticle`. Items are visible as soon as discover stores them. Examples: `rss`, `substack`. This shape also fits a page that lists several articles in full.
2. **Scraped:** `discover` returns candidates (guid, url, title, dates), and `fetchArticle` fetches and cleans each article page later. Each candidate is stored as `pending`, and one queue message per item runs `fetchArticle` in its own Runner object. Only items that finish as `ok` reach your apps. An item that keeps failing ends as `error`.

## The interface

```ts
import { defineSource } from "@rss8/engine";

interface Options { url: string }
interface State { lastSeen?: string }

export default defineSource<Options, State>({
  apiVersion: 1,
  kind: "example",                    // what the config's `source` names
  defaultSchedule: ["*/30 * * * *"],  // used when a feed sets no `schedule`
  parseOptions(raw) {                 // validate the feed's `options`; throw to reject
    const url = (raw as { url?: unknown })?.url;
    if (typeof url !== "string") throw new Error("example: options.url is required");
    return { url };
  },
  async discover(feed, ctx) { /* return Candidate[] */ },
  async fetchArticle(candidate, ctx) { /* return { content, ...overrides } */ },
  inspect: { /* optional, for the inspect tool (below) */ },
});
```

Register it in your deployment's entry point (`createWorker({ sources: [rss, example], config })`) and give a feed `source: "example"` in `rss8.config.ts`. A config naming an unknown source fails the deploy.

### `discover(feed, ctx)`

Returns the items currently listed. The engine stores the new ones and ignores guids it already has, including tombstoned ones. You don't need to work out what's new.

- **`guid`** must be unique across all sources and stable forever. Prefix the site's native id with your kind: `example-<id>`. If two feeds can carry the same entry, include the feed key too (as `rss` does: `rss-<feed key>-<entry id>`).
- **Dates** are epoch seconds. Some feeds are oldest first. The engine keeps the newest 100 by date, so return everything you parse.
- **`ctx.fetchFeed(url)`** makes a conditional GET using the stored `ETag`/`Last-Modified`. It reads at most 4 MB and reports `truncated`. `{ notModified: true }` means there's nothing to do.
- **`ctx.parseFeed(xml)`** parses RSS or Atom into entries (`id`, `url`, `title`, `summary`, `content`, `author`, `published`, `updated`).
- **`ctx.state`** is the feed's own bookkeeping, stored as JSON in the feed row, for example the last edition seen. A `set` is saved only if the whole run succeeds. This is the only place a source keeps data. Sources never create tables.
- **`ctx.fetch`** is `fetch` with a desktop browser user agent and a timeout. **`ctx.log`** writes to the Worker logs.

Throw to fail the run. The queue retries it, and if it fails for good the `system` feed reports it.

### `fetchArticle(candidate, ctx)`

Fetches one article and returns `{ content }`, plus any of `url`, `title`, `summary`, `author`, `published` and `updated` you want to override. Fields you leave out keep the candidate's values. Throw on anything you don't recognise, such as a missing container or a result that's suspiciously short. Storing an empty or broken article is worse than an `error`.

## Rules that keep it within the free plan

Each article runs in a Durable Object with about 30 s of CPU, but design for **at most 1 s**, and the cheaper the better. Done this way, one news site's scraped articles cost at most 15 ms each in a measured sample.

- **Count subrequests.** There are 50 per invocation, and redirects and retries count. Fetch the canonical URL, not one that redirects.
- **No retry loops.** Throw, and let the queue retry with a delay.
- **No work in `alarm()`.** A failed alarm retries by itself, outside the queue's retry policy.
- **Isolate the article by string search first.** A full page is often about 500 KB, and a selector is evaluated against every element. Find the container's start with `indexOf` or a regex, then find its end by counting `<div`/`</div>` (or whatever wraps it).
- **Use HTMLRewriter only on the isolated fragment, and only for work that touches few elements:** removing blocks, fixing `img`. Don't register handlers on `*` or on text nodes, because each call costs CPU. Read the result with `text()` or `arrayBuffer()`, not by piping into a JS `WritableStream`.
- **Normalise with regex:** attributes, wrapper tags, comments, whitespace.
- **No JS DOM libraries.** They're too slow for a page this size.
- **Objects are stateless.** Nothing goes in an object's storage, and no in-memory cache survives between requests.

## Testing with `@rss8/source-kit`

Save real pages as fixtures and lock in the expected output. Put your source in `sources/<kind>/` of your deployment repo: the tools default to `sources/<kind>/fixtures` and `sources/<kind>/golden`.

```ts
// sources/example/test/fixtures.test.ts
import { byName, describeFixtures } from "@rss8/source-kit";
import { cleanArticle } from "../clean";

describeFixtures("example articles", {
  pages: byName(import.meta.glob<string>("../fixtures/*.html", { query: "?raw", import: "default", eager: true })),
  process: cleanArticle,
  expectedDir: "../golden",
});
```

Each fixture becomes one test that compares the output with `golden/<id>.html`. A missing expected file is written on the first run, and `vitest -u` rewrites them all. Check the diff before committing. If you're porting an older scraper, pass its outputs as `reference`: they are compared by text, images, links and iframes rather than byte for byte.

Tests run in workerd through `@cloudflare/vitest-plugin`, so HTMLRewriter is real.

## The `inspect` tool

Implement `inspect` on your source to get a fast loop against live pages:

```ts
inspect: {
  fetchPage: (id, ctx) => ctx.fetch(`https://example.com/a/${id}`).then((r) => r.text()),
  process: async (page, { stage } = {}) => ({ content: await cleanArticle(page, stage), details: {} }),
},
```

`process` must run the same code as `fetchArticle`. It's only split so that a saved page can be processed offline. Name your stages (for example `isolate`, `clean`) and throw on an unknown one.

```bash
npm run -s inspect -- example <id> --pretty --open             # live page, shown in a browser
npm run -s inspect -- example <id> --save-raw sources/example/fixtures/<id>.html
npm run -s inspect -- example <id> --file sources/example/fixtures/<id>.html --stage isolate
npm run -s inspect -- example <id> --diff                      # compare with golden/<id>.html
npm run -s inspect -- example <id> --update-golden
npm run -s inspect -- example <id> --remote                    # run on the deployed Worker
```

The tool starts your Worker locally with the `/dev` routes on and runs the pipeline in a real Runner object. `--remote` calls `/admin/clean` on the deployment instead (it needs `RSS8_URL` and `RSS8_ADMIN_TOKEN`). Use it when local output is fine but production stores errors: a site may serve Cloudflare's IPs different HTML.

## Measuring CPU

A Worker can't time its own CPU, so `measure` reads it from `wrangler tail`:

1. Deploy a throwaway Worker with the `/dev` routes on and no D1, queue or cron.
2. Run `npm run measure -- example --url <its url>`. It runs each fixture once, fetching live and posting the saved page, and reports CPU per invocation.
3. Delete the throwaway Worker afterwards.

Never set `DEV_ROUTES` on production: the `/dev` routes have no authentication.

## Checklist for a new source

- [ ] An existing source doesn't already fit.
- [ ] Guids are prefixed, unique and stable.
- [ ] `parseOptions` rejects a bad config.
- [ ] Bookkeeping lives in `ctx.state` only.
- [ ] Fixtures cover varied pages: old and new layouts, video-only, very short and very long.
- [ ] Measured CPU per article is well under 1 s.
- [ ] A missing container or empty result throws.
