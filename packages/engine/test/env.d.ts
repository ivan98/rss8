declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    TEST_QUEUE_CONSUMERS: string;
    TEST_CRONS: string;
  }
}
