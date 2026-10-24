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
}
