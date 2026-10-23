export type EngineMessage = { type: "discover"; feedId: number } | { type: "article"; itemId: number };

/** Must equal the consumer's `max_retries` in the Wrangler config. */
export const MAX_RETRIES = 3;
export const RETRY_DELAY_SECONDS = 600;
/** Queues' limit on messages per `sendBatch`. */
export const SEND_BATCH_LIMIT = 100;

export function parseMessage(body: unknown): EngineMessage | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const m = body as Record<string, unknown>;
  if (m.type === "discover" && Number.isSafeInteger(m.feedId)) return { type: "discover", feedId: m.feedId as number };
  if (m.type === "article" && Number.isSafeInteger(m.itemId)) return { type: "article", itemId: m.itemId as number };
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
