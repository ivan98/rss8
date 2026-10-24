import type { EngineMessage } from "./messages";
import type { Api } from "./api";
import type { Runner } from "./runner";

export interface EngineEnv {
  RUNNER: DurableObjectNamespace<Runner>;
  API: DurableObjectNamespace<Api>;
  DB: D1Database;
  QUEUE: Queue<EngineMessage>;
  /** "1" turns on the `/dev` routes. Only the `inspect` tool and measurement Workers set it; production never does. */
  DEV_ROUTES?: string;
  /** The Google Reader password (secret). Without it, and AUTH_SECRET, the API refuses every login. */
  API_PASSWORD?: string;
  /** Signs the Google Reader tokens (secret, at least 32 characters). */
  AUTH_SECRET?: string;
  /** Bearer token for the `/admin` routes (secret, at least 32 characters). Without it they answer 503. */
  ADMIN_TOKEN?: string;
  /** The deployment's `version_metadata` binding; `/health` reports its tag. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}
