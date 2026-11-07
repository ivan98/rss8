import { configDefaults, defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { unstable_readConfig } from "wrangler";

// The tests run against the example deployment: its Worker re-exports the
// engine's Runner and Api classes, which the engine tests drive directly.
const configPath = "./examples/basic/wrangler.jsonc";
const wrangler = unstable_readConfig({ config: configPath });

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath },
      miniflare: {
        bindings: {
          // Test-only values; the real ones are Worker secrets.
          API_PASSWORD: "test-password",
          AUTH_SECRET: "test-auth-secret-0123456789abcdef",
          TEST_MIGRATIONS: await readD1Migrations("packages/engine/migrations"),
          TEST_QUEUE_CONSUMERS: JSON.stringify(wrangler.queues.consumers ?? []),
          TEST_CRONS: JSON.stringify(wrangler.triggers.crons ?? []),
        },
      },
    })),
  ],
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
    setupFiles: ["packages/engine/test/apply-migrations.ts"],
    // The persisted transform cache keeps an import.meta.glob's old file list,
    // so a newly saved fixture would silently go untested.
    fsModuleCache: false,
  },
});
