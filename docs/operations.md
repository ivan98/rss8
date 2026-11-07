# Operating rss8

How to keep an rss8 deployment healthy: what it tells you, the admin routes, CI and previews, rollbacks, and the free-plan limits worth watching. For the first deploy, see the [README](../README.md#deploy-and-run).

## What rss8 tells you

- **The `system` feed.** rss8 posts to its own feed, so the news reaches your reader and syncs like any other item:
  - when a feed's discover fails for good (a 403, or the last retry) and when it recovers;
  - when the daily maintenance run fails;
  - every day after maintenance (at 05:15 in your `timezone`), a health report. It covers each feed (items crawled in the last 24 hours, how many ended in error, the last fetch, a status), the library totals, what maintenance removed, the database size against 500 MB, and the deployed version.

  A missing daily report is a signal in itself: the cron or maintenance has stopped. Set the feed's `enabled: false` to stop the messages.
- **`GET /health`** answers `{"status":"ok","version":<tag>,"versionId":<id>}`. Bind `version_metadata` as `CF_VERSION_METADATA` to fill in the version.
- **Logs.** Workers Logs or `wrangler tail` show each tick, discover, article and API call. Cloudflare masks the `Authorization` header in both.

## Secrets

| Secret | Purpose |
|---|---|
| `API_PASSWORD` | The password your apps sign in with, at least 8 characters. Any user name is accepted |
| `AUTH_SECRET` | Signs the login and write tokens, at least 32 characters. Changing it, or the password, signs every app out |
| `ADMIN_TOKEN` | Bearer token for `/admin`, at least 32 characters. Without it every admin route answers 503 |

Set them with `npx wrangler secret put <NAME>`. Never put them in a file in the repo.

## Admin routes

Every route needs `Authorization: Bearer <ADMIN_TOKEN>`.

| Route | What it does |
|---|---|
| `POST /admin/discover?feed=<key>` | Syncs the config, then runs one discover for the feed now, even if it is disabled. Returns the new item ids |
| `POST /admin/article?id=<id>` | Fetches and stores one pending item's article. Returns `{id, status}` |
| `POST /admin/requeue?status=error` | Sets every item in `error` back to pending and queues its article again. Use it after fixing a source |
| `GET /admin/clean/<kind>/<id>` | Runs a source's article pipeline on the deployed Worker without storing anything (`npm run inspect -- <kind> <id> --remote` calls it). It shows what Cloudflare's IPs are served, which can differ from what you get locally |

```bash
curl -X POST -H "Authorization: Bearer $RSS8_ADMIN_TOKEN" "$RSS8_URL/admin/requeue?status=error"
```

## How items fail and recover

- A discover or article that fails is retried by the queue, with a delay, up to `max_retries`. There are no retry loops inside an invocation.
- An article that still fails is stored as `error` and stays hidden from your apps. Retention removes it after `readDays`, unless you requeue it first.
- An item left `pending` for more than a day becomes `error` at the next maintenance run.
- Removed items leave a tombstone (the id, no content) for `tombstoneDays`, so a feed that still lists an old post can't bring it back as new and unread.

## CI and previews

rss8 doesn't ship a workflow. This is the shape that works well with GitHub Actions and `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets. The token comes from the "Edit Cloudflare Workers" template, plus D1 and Queues edit.

- **On every push:** `npm run check` and `npx wrangler deploy --dry-run`. The dry run catches a missing `Runner` or `Api` re-export.
- **Deploy only when the Worker changes.** Pushes that touch only docs or test data can skip the deploy.
- **On merge to `main`:**
  1. `npx wrangler d1 migrations apply <db> --remote`, always before the code.
  2. `npx wrangler deploy --tag <version> --message "<commit subject>"`.
  3. A smoke test: `/health` reports the new `versionId` within a minute, and a `ClientLogin` with a random wrong password answers 401. A 503 there means the API secrets are missing.
  4. Optionally, a git tag and GitHub Release with the same version string, so the dashboard and the repo agree.
- **A preview per pull request.** `wrangler preview --name pr-<number>` gives each PR its own Durable Object namespaces. Give it its own bindings in the `previews` block of `wrangler.jsonc`:
  - a separate D1 database (without it, a preview reads and writes production rows);
  - a queue nobody consumes, so a preview's messages never reach production.

  A preview runs no cron and no queue consumer, so drive it with `/admin/discover` and `/admin/article`. Point a second account in your reader at the preview URL to try API changes against a real app before merging. Migrations don't see a database bound only under `previews`, so apply them with a small config that binds the preview database at the top level.

  `wrangler versions upload` is no substitute: Cloudflare serves no version preview URL for a Worker with Durable Objects.

## Rollback and the rules that keep it safe

- **Code:** `npx wrangler rollback` returns to an earlier version. `/health` then shows the rolled-back version.
- **Data:** D1 Time Travel restores the database to any point in the last 7 days on the free plan.
- **Migrations only ever add.** Add columns; never rename or drop one in the same release. Older code then always runs against the newer schema, which is what makes a rollback possible.
- **Durable Object class changes ship alone.** Adding, renaming or deleting a class in the `exports` block goes in its own deploy, with no other code change. Deleting a class deletes its data without a prompt, and `wrangler rollback` refuses to cross a class change. rss8's objects hold no data, but the rule still keeps rollbacks possible. A CI check that fails when `exports` differs from production's is worth having.
- **The config is the source of truth.** Toggle a feed by editing `rss8.config.ts` and deploying, not by changing D1 by hand: the next tick would undo it.

## Limits worth watching

| Allowance | Limit | Notes |
|---|---|---|
| D1 rows read | 5 M a day | The closest to its limit. Every sync reads the complete unread and starred id sets, about one row per id: roughly 2.8 M a day at 9,000 retained items with three devices syncing every 15 minutes. Shorten retention or sync less often if it grows |
| D1 rows written | 100 k a day | |
| D1 storage | 500 MB | Above 400 MB, maintenance tombstones the oldest unread items early and says so in the daily report |
| Queue operations | 10 k a day | About 3 per message, one message per discover and per article |
| Worker requests | 100 k a day | |
| Durable Objects | 100 k requests and 13,000 GB-s a day | |
| CPU per plain Worker invocation | 10 ms | The Workers only route, well within it. Overages don't fail early, so check the CPU P99 in the dashboard now and then |
| CPU per Durable Object invocation | About 30 s | rss8 designs every invocation for at most 1 s |
| Subrequests per invocation | 50 | Redirects and retries count |

The Cloudflare dashboard shows D1 rows read and written, queue operations and CPU percentiles. rss8 can't report these itself without an analytics API token.
