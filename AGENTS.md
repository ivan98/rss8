# rss8

A self-hosted, single-user RSS aggregator that runs entirely on Cloudflare Workers' free plan. The engine fetches feeds, can scrape full articles where a source needs it, stores items in D1, and serves the Google Reader API to native reader apps (tested: Reeder Classic 5.6, Unread, NetNewsWire). Read and starred state syncs between devices through that API. The heavy work runs in Durable Objects; plain Workers only route (see the limits below).

What it is for, how to deploy it and how to write a source: `README.md`, `docs/operations.md`, `docs/writing-a-source.md`.

## Scope

- **Google Reader API only.** The Fever API is out of scope.
- **No web reading interface.** Besides the API, the Worker serves only `/admin`, `/health` and the dev-only `/dev` routes.
- **One user.** One password; any user name is accepted.
- **Feeds and folders come from the config.** A feed sits in at most one folder (`category`). Folder edits from clients are refused, and single articles carry no labels.
- **Adding a source must never need schema or engine changes.**

## Layout

```
packages/engine/         schema + migrations, queue protocol, cron dispatcher,
                         Durable Object classes (Runner, Api), feed fetching and parsing,
                         Google Reader API, auth, maintenance, admin routes
packages/engine/migrations/  D1 migrations (engine-owned)
packages/engine/test/transcripts/  scrubbed Reeder and Unread request transcripts (sync contract tests)
packages/source-rss/     generic RSS/Atom source: entries stored complete, no fetchArticle
packages/source-substack/  Substack feeds: as source-rss, plus a pass that reduces Substack's page markup to plain HTML
packages/source-kit/     source helpers, fixture/golden test harness, `inspect` and `measure` tools
examples/basic/          a deployment to copy: entry point, config, wrangler.jsonc; also the Worker the tests run against
docs/                    operations.md, writing-a-source.md
```

## Hard rules

- Everything here is public. No publisher-specific selectors, URLs, real item ids, personal data or secrets in code, test data or commit messages. Test feeds and pages are synthetic. A source that strips one publisher's content belongs in the deployment's own repo, not here.
- The engine owns the D1 schema. Sources never create tables; they keep their own bookkeeping in `feed.state` (JSON).
- D1 is the only durable store. Durable Objects are stateless: nothing goes in an object's own storage, and no in-memory cache is relied on between requests (an idle object is replaced after about 10 s).
- Durable Object classes are declared with the Wrangler `exports` block, and a deployment re-exports them from the engine under fixed names (`Runner`, `Api`). A class change (add, rename, delete) ships in its own deploy with no other code change: deleting a class deletes its data with no prompt, and rollback never crosses a class change.
- `rss8.config.ts` is the source of truth for feeds. The engine syncs D1 to it; nothing flips `enabled` in D1 by hand.
- Migrations are forward-only and backward-compatible: add columns, never rename or drop them in the same release.
- Secrets go in with `wrangler secret put`. Never put them in files, configs, docs or test fixtures.
- The `Source` interface (`apiVersion`) and `createWorker` are the public API. Change them deliberately and keep deployments' sources compiling.

## Free-plan limits that shape the code

| Limit | Value |
|---|---|
| CPU per plain Worker invocation (fetch handler, cron, queue consumer) | 10 ms. Network waits don't count. Rare overages are tolerated (12–583 ms invocations completed in tests; `exceededCpu` only at about 2 s), but design and measure to 10 ms |
| CPU per Durable Object invocation (`fetch` or alarm) | About 30 s (cut off at 30–32.5 s in tests). Design to at most 1 s and measure |
| Subrequests per invocation | 50, in plain Workers and objects alike (redirects and retries count; D1 queries don't) |
| D1 queries per invocation | 50 (not enforced in tests, but assume a `batch()` counts as N) |
| Cron triggers per account | 5. Use exactly 1; the engine evaluates schedules itself |
| Worker requests per day | 100k |
| Durable Objects per day | 100k requests, 13,000 GB-s of duration. SQLite-backed objects only, 100 classes and 5 GB per account |
| Queue operations per day | 10k (about 3 per message; one message per discover and per article) |
| D1 database size | 500 MB |
| D1 rows read per day | 5M. **Rows scanned count**, so every sync query must hit an index and read about 1 row per returned id. This is the allowance closest to its limit (about 2.8M a day at 9,000 retained items and three devices syncing every 15 minutes) |
| D1 rows written per day | 100k |

Consequences:
- Plain Workers only route, at or under 10 ms CPU. The cron enqueues; the queue consumer processes one message each (`max_batch_size = 1`) and forwards it to a Durable Object with `fetch`; the fetch handler forwards the Google Reader API to the Api object.
- All heavy work runs in Durable Objects, one unit of work per invocation: one Runner object per feed for discover (`feed:<key>`), one per article (`item:<id>`), one Api object for the Google Reader API. Design each invocation to at most 1 s CPU and measure it (a scraped news article measured at most 15 ms; a full 9,000-item `contents` streamed at most 670 ms).
- Feeds: read at most 4 MB of decoded body with a BYOB `readAtLeast` reader (not `content-length`), parse every item, and keep the newest 100 by date. Some feeds are oldest first.
- HTML work: isolate the article from the full page by string search, because selectors are evaluated against every element and a full page is about 500 KB. Use HTMLRewriter only for work that touches few elements on the isolated fragment (removals, `img`), and normalise attributes, wrapper tags, comments and whitespace with regex. Don't register handlers on `*` or on text nodes: each handler call costs CPU. Don't `pipeTo` a JS `WritableStream` as a rewriter sink; read the result with `text()` or `arrayBuffer()`. Never use a JS DOM library. These rules still apply inside objects: the object removes the CPU ceiling but doesn't make the work cheaper.
- No retry loops inside an invocation. Retry through `msg.retry({ delaySeconds })`. Don't run work in an object's `alarm()` handler: a failed alarm retries by itself, outside the queue's retry policy.

## Commands

- `npm run check`: typecheck, lint and tests; run it before every commit. `npm run typecheck` regenerates `worker-configuration.d.ts` from `examples/basic/wrangler.jsonc` (gitignored) and runs `tsc`.
- `npm test`: vitest in workerd (`@cloudflare/vitest-plugin`) against the `examples/basic` Worker: the engine and source tests, the sync contract tests and the object classes (`runInDurableObject`; storage is isolated per test file, so use `reset()` between tests).
- `npm run deploy:dry-run`: bundles `examples/basic` without deploying; fails if it stops re-exporting `Runner` or `Api`.
- `npx wrangler d1 migrations create rss8 <name> -c examples/basic/wrangler.jsonc` adds a migration under `packages/engine/migrations/`.
- `packages/source-kit/cli/inspect.ts` and `measure.ts` run from a deployment's repo (see `docs/writing-a-source.md`).

## Sync correctness (Google Reader API)

These rules must hold:
- `stream/items/ids` returns the **complete** id sets (unread, starred, and read since `ot`), with `n` up to 100,000 (Unread sends 100000) and correct `c` continuation paging.
- Only `status='ok'` items are visible to clients.
- `mark-all-as-read` only marks items with `crawled_at ≤ ts`. `ts` is usually in microseconds, so check its magnitude.
- Retention never deletes starred items.
- Item ids are accepted in three forms: plain decimal (Unread), bare 16-digit hex (Reeder) and the long `tag:google.com,2005:reader/item/<hex>`. FreshRSS's rule: all digits and not starting with `0` is decimal; otherwise hex.
- The API is served under `/api/greader.php/` (FreshRSS account type, Unread, NetNewsWire) and at the host root, `/accounts/ClientLogin` and `/reader/api/0/...` (Reeder's "Reader" account type).
- The `edit-tag` write token `T` is optional (Unread sends none). `GET /api/greader.php` answers exactly `OK`, or Unread refuses the URL.

Test sync behaviour by replaying the scrubbed request transcripts in `packages/engine/test/transcripts/`, and add new ones captured from real clients (scrub credentials and tokens first).
