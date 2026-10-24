export type EngineMessage =
  /** `manual` runs the feed even when it is disabled; only the admin route sets it. */
  | { type: "discover"; feedId: number; manual?: true }
  | { type: "article"; itemId: number }
  /** `date` is the local day it runs for; `now` is the cron tick, in epoch ms. */
  | { type: "maintenance"; date: string; now: number };

/** Must equal the consumer's `max_retries` in the Wrangler config. */
export const MAX_RETRIES = 3;
export const RETRY_DELAY_SECONDS = 600;
/** The gap between consecutive article messages, so their fetches don't reach the origin at once. */
export const ARTICLE_STAGGER_SECONDS = 2;
/** Queues' limit on a message's `delaySeconds`. */
export const MAX_DELAY_SECONDS = 86_400;
/** Queues' limit on messages per `sendBatch`. */
export const SEND_BATCH_LIMIT = 100;

export function parseMessage(body: unknown): EngineMessage | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const m = body as Record<string, unknown>;
  if (m.type === "discover" && Number.isSafeInteger(m.feedId)) {
    const feedId = m.feedId as number;
    return m.manual === true ? { type: "discover", feedId, manual: true } : { type: "discover", feedId };
  }
  if (m.type === "article" && Number.isSafeInteger(m.itemId)) return { type: "article", itemId: m.itemId as number };
  if (m.type === "maintenance" && typeof m.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.date)) {
    if (Number.isSafeInteger(m.now)) return { type: "maintenance", date: m.date, now: m.now as number };
  }
  return undefined;
}

export async function sendAll(
  queue: Queue<EngineMessage>,
  messages: MessageSendRequest<EngineMessage>[],
): Promise<void> {
  for (let i = 0; i < messages.length; i += SEND_BATCH_LIMIT) {
    await queue.sendBatch(messages.slice(i, i + SEND_BATCH_LIMIT));
  }
}
