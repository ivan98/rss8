import type { EngineMessage } from "./messages";
import type { Api } from "./api";
import type { Runner } from "./runner";

export interface EngineEnv {
  RUNNER: DurableObjectNamespace<Runner>;
  API: DurableObjectNamespace<Api>;
  DB: D1Database;
  QUEUE: Queue<EngineMessage>;
}
