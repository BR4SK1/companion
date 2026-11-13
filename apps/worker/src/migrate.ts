import { pathToFileURL } from "node:url";

import { closePostgresPool, createPostgresPool } from "@companion/postgres";

import { applyWorkerMigrations } from "./migrations.ts";

/** Apply the worker's full ordered schema and exit without starting services. */
async function main(): Promise<void> {
  const databaseUrl = process.env.WORKER_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error("WORKER_DATABASE_URL is required");
    process.exitCode = 2;
    return;
  }

  const pool = createPostgresPool({ connectionString: databaseUrl });
  try {
    const result = await applyWorkerMigrations(pool);
    if (result.applied.length > 0) {
      console.log(`applied migrations: ${result.applied.join(", ")}`);
    }
    if (result.alreadyApplied.length > 0) {
      console.log(`already applied migrations: ${result.alreadyApplied.join(", ")}`);
    }
    if (result.unrecognized.length > 0) {
      console.warn(
        `unrecognized recorded migrations (left untouched): ${result.unrecognized.join(", ")}`,
      );
    }
  } finally {
    await closePostgresPool(pool);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
