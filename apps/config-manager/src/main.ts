/**
 * Entry point for the standalone local configuration manager.
 *
 * Launch (loopback only, fixed environment):
 *
 *   CONFIG_MANAGER_ENVIRONMENT=nonprod \
 *   CONFIG_MANAGER_DATABASE_URL=<non-production URL> \
 *   pnpm --filter @companion/config-manager start
 *
 * Production edits require a separate launch with
 * `CONFIG_MANAGER_ENVIRONMENT=production`; there is no in-browser switch.
 * The database URL is read only from the server environment and is never
 * logged or returned.
 */

import { loadConfigManagerConfig } from "./config.ts";
import { createPostgresConfigStore } from "./store.ts";
import { startConfigManagerServer } from "./server.ts";

async function main(): Promise<void> {
  const config = loadConfigManagerConfig(process.env);
  const store = createPostgresConfigStore(config.databaseUrl);
  const running = await startConfigManagerServer({
    environment: config.environment,
    store,
    host: config.host,
    port: config.port,
    maxBodyBytes: config.maxBodyBytes,
    log: (message) => {
      // Server-side only; never includes the database URL or content.
      console.error(`[config-manager] ${message}`);
    },
  });
  console.log(
    `[config-manager] listening on http://${config.host}:${running.address.port} for ${config.environment} (loopback-only, fixed server-side binding)`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[config-manager] failed to start: ${message}`);
  process.exit(1);
});
