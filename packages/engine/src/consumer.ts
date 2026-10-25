import type { EngineEnv } from "./env";
import { FINAL_FAILURE_STATUS, MAX_RETRIES, parseMessage, RETRY_DELAY_SECONDS, type EngineMessage } from "./messages";
import { postSystemMessage } from "./system-feed";

interface Failure {
  error: string;
  /** A retry can't fix it. */
  final: boolean;
}

/**
 * Routes each message to its Runner object and waits on it (network wait, not
 * CPU). A failure retries through the queue; the last attempt, or a failure
 * the Runner marks final, records the error and acks, so the message isn't
 * redelivered. A failed discover also records each attempt on the feed, so
 * the cause shows before the retries run out.
 */
export async function consume(batch: MessageBatch, env: EngineEnv): Promise<void> {
  for (const msg of batch.messages) {
    const message = parseMessage(msg.body);
    if (!message) {
      console.error("Dropping unknown message", msg.body);
      msg.ack();
      continue;
    }
    const failure = await route(env, message).catch(
      (e: unknown): Failure => ({ error: e instanceof Error ? e.message : String(e), final: false }),
    );
    if (failure === undefined) {
      msg.ack();
    } else if (failure.final) {
      await recordFailure(env.DB, message, `${message.type} failed, not retried: ${failure.error}`);
      msg.ack();
    } else if (msg.attempts > MAX_RETRIES) {
      await recordFailure(env.DB, message, `${message.type} failed after ${msg.attempts} attempts: ${failure.error}`);
      msg.ack();
    } else {
      const retrying = `${message.type} attempt ${msg.attempts} of ${MAX_RETRIES + 1} failed, retrying in ${RETRY_DELAY_SECONDS / 60} min: ${failure.error}`;
      console.error(`${subject(message)}: ${retrying}`);
      if (message.type === "discover") await recordFeedError(env.DB, message.feedId, retrying);
      msg.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}

/** Undefined on success. */
async function route(env: EngineEnv, message: EngineMessage): Promise<Failure | undefined> {
  let name: string;
  switch (message.type) {
    case "discover": {
      const key = await env.DB.prepare("SELECT key FROM feed WHERE id = ?").bind(message.feedId).first<string>("key");
      if (key === null) return undefined;
      name = `feed:${key}`;
      break;
    }
    case "article":
      name = `item:${message.itemId}`;
      break;
    case "maintenance":
      name = "maintenance";
      break;
  }
  const res = await env.RUNNER.getByName(name).fetch(`https://runner/${message.type}`, {
    method: "POST",
    body: JSON.stringify(message),
  });
  if (res.ok) return undefined;
  return { error: (await res.text()) || `HTTP ${res.status}`, final: res.status === FINAL_FAILURE_STATUS };
}

async function recordFailure(db: D1Database, message: EngineMessage, error: string): Promise<void> {
  console.error(`${subject(message)}: ${error}`);
  const now = Date.now();
  switch (message.type) {
    case "discover": {
      // failing_since keeps the first failure of a run, and the message's guid
      // is built from it, so every later failure posts the same message: stored
      // once, and still posted if an earlier attempt to post it failed.
      const feed = await db
        .prepare(
          `UPDATE feed SET last_error = ?2, failing_since = COALESCE(failing_since, ?3) WHERE id = ?1
           RETURNING key, title, site_url, failing_since`,
        )
        .bind(message.feedId, error, now)
        .first<{ key: string; title: string; site_url: string | null; failing_since: number }>();
      if (feed) {
        const ref = { key: feed.key, title: feed.title, siteUrl: feed.site_url };
        await postSystemMessage(db, { type: "feed-failing", feed: ref, since: feed.failing_since, error }, now);
      }
      break;
    }
    case "article":
      // Guarded on 'pending': a late duplicate must not turn a finished item into an error.
      await db
        .prepare("UPDATE item SET status = 'error' WHERE id = ? AND status = 'pending'")
        .bind(message.itemId)
        .run();
      break;
    case "maintenance":
      // Nothing else to record: the next local day's run continues where this one stopped.
      await postSystemMessage(db, { type: "maintenance-failed", date: message.date, error }, now);
      break;
  }
}

function subject(message: EngineMessage): string {
  switch (message.type) {
    case "discover":
      return `feed ${message.feedId}`;
    case "article":
      return `item ${message.itemId}`;
    case "maintenance":
      return `maintenance ${message.date}`;
  }
}

async function recordFeedError(db: D1Database, feedId: number, error: string): Promise<void> {
  await db.prepare("UPDATE feed SET last_error = ? WHERE id = ?").bind(error, feedId).run();
}
