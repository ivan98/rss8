import type { EngineEnv } from "./env";
import { MAX_RETRIES, parseMessage, RETRY_DELAY_SECONDS, type EngineMessage } from "./messages";

/**
 * Routes each message to its Runner object and waits on it (network wait, not
 * CPU). A failure retries through the queue; the last attempt records the
 * error in D1 and acks, so the message isn't redelivered.
 */
export async function consume(batch: MessageBatch, env: EngineEnv): Promise<void> {
  for (const msg of batch.messages) {
    const message = parseMessage(msg.body);
    if (!message) {
      console.error("Dropping unknown message", msg.body);
      msg.ack();
      continue;
    }
    const failure = await route(env, message).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (failure === undefined) {
      msg.ack();
    } else if (msg.attempts > MAX_RETRIES) {
      await recordFailure(env.DB, message, `${message.type} failed after ${msg.attempts} attempts: ${failure}`);
      msg.ack();
    } else {
      msg.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}

/** Undefined on success, else the failure's description. */
async function route(env: EngineEnv, message: EngineMessage): Promise<string | undefined> {
  let name: string;
  if (message.type === "discover") {
    const key = await env.DB.prepare("SELECT key FROM feed WHERE id = ?").bind(message.feedId).first<string>("key");
    if (key === null) return undefined;
    name = `feed:${key}`;
  } else {
    name = `item:${message.itemId}`;
  }
  const res = await env.RUNNER.getByName(name).fetch(`https://runner/${message.type}`, {
    method: "POST",
    body: JSON.stringify(message),
  });
  if (res.ok) return undefined;
  return (await res.text()) || `HTTP ${res.status}`;
}

async function recordFailure(db: D1Database, message: EngineMessage, error: string): Promise<void> {
  if (message.type === "discover") {
    await db.prepare("UPDATE feed SET last_error = ? WHERE id = ?").bind(error, message.feedId).run();
  } else {
    // Guarded on 'pending': a late duplicate must not turn a finished item into an error.
    await db.prepare("UPDATE item SET status = 'error' WHERE id = ? AND status = 'pending'").bind(message.itemId).run();
    console.error(`item ${message.itemId}: ${error}`);
  }
}
