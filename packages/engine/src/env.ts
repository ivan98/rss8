import type { EngineMessage } from "./messages";
import type { Api } from "./api";
import type { Runner } from "./runner";

export interface EngineEnv {
  RUNNER: DurableObjectNamespace<Runner>;
  API: DurableObjectNamespace<Api>;
  DB: D1Database;
  QUEUE: Queue<EngineMessage>;
  /** The Google Reader password (secret). Without it, and AUTH_SECRET, the API refuses every login. */
  API_PASSWORD?: string;
  /** Signs the Google Reader tokens (secret, at least 32 characters). */
  AUTH_SECRET?: string;
}
