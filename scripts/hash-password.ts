/**
 * Generate an ADMIN_PASSWORD_HASH (scrypt, `salt:hash` hex) for .env.
 *   npx tsx scripts/hash-password.ts 'my-strong-password'
 *
 * Self-contained (no Next imports) so it runs as a plain node/tsx script.
 * Must stay in sync with verifyPassword() in lib/auth.ts.
 */
import { scryptSync, randomBytes } from "node:crypto";

const password = process.argv[2];
if (!password) {
  console.error("Usage: tsx scripts/hash-password.ts '<password>'");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64);
console.log(`${salt.toString("hex")}:${hash.toString("hex")}`);
