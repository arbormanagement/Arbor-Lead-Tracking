/**
 * Seeds the canonical `sources` and `pools` dimensions. Idempotent — safe to
 * re-run.
 *   npm run db:seed
 *
 * Normally unnecessary: `npm run db:deploy` seeds as part of every release. This
 * stays for local setup and for re-seeding a fresh database by hand.
 */
import { sql } from "drizzle-orm";
import { connectForSchemaWork, resolveDriver } from "../lib/db/connect";
import { seedDefaults } from "../lib/db/seed-data";
import * as schema from "../lib/db/schema";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");

const { db, close } = connectForSchemaWork(url, resolveDriver(process.env.DB_DRIVER));

async function main() {
  const { pools } = await seedDefaults(db, (label) => console.log(`✓ ${label}`));
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.sources);
  console.log(`Done — ${count} sources, ${pools} pools.`);
}

main()
  .then(() => close())
  .catch(async (e) => {
    console.error(e);
    await close();
    process.exit(1);
  });
