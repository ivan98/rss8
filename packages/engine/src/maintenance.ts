import type { Config } from "./config";

export interface MaintenanceReport { tombstoned: number; deleted: number; erred: number; warning?: string }

export async function runMaintenance(db: D1Database, config: Config, now: number): Promise<MaintenanceReport> { return { tombstoned: 0, deleted: 0, erred: 0 }; }
