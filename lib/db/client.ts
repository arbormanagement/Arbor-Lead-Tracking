import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Neon HTTP driver — ideal for Vercel serverless: each query is a stateless HTTPS
 * round-trip, no WebSocket/long-lived pool, fast cold starts.
 *
 * Note for Phase 4 (pooled DNI leasing): the `SELECT ... FOR UPDATE SKIP LOCKED`
 * lease needs an interactive transaction. The HTTP driver only does non-interactive
 * batches, so that path will open a short-lived `Pool` (neon-serverless) instead.
 * Everything else in the app uses this client.
 */
const sql = neon(env.DATABASE_URL);

export const db = drizzle(sql, { schema, casing: "snake_case" });
export { schema };
export type Db = typeof db;
