/**
 * Apply Drizzle migrations over Neon's HTTP driver (HTTPS), so it works in
 * environments where raw Postgres TCP (5432) egress is blocked. Equivalent to
 * `drizzle-kit migrate` but transport-compatible with HTTPS-only networks.
 *   DATABASE_URL_UNPOOLED=… npx tsx scripts/migrate-http.ts
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");

const db = drizzle(neon(url));

async function main() {
  await migrate(db, { migrationsFolder: "lib/db/migrations" });
  console.log("✓ migrations applied");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
