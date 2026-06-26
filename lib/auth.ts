import { createHmac, timingSafeEqual, scryptSync, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * Minimal single-admin auth for an internal tool. We sign a stateless session
 * token with HMAC-SHA256 over the cookie-signing secret — no session table, no
 * external auth provider. Passwords are verified against ADMIN_PASSWORD_HASH
 * (scrypt) so the plaintext never lives in env.
 *
 * If this app ever grows multiple users, swap this for the `users`/`auth_sessions`
 * tables already defined in the schema.
 */

const COOKIE = SESSION_COOKIE;
const MAX_AGE_SEC = 60 * 60 * 12; // 12h

interface SessionPayload {
  email: string;
  exp: number;
}

function sign(data: string): string {
  return createHmac("sha256", env.COOKIE_SIGNING_SECRET).update(data).digest("base64url");
}

export function createSessionToken(email: string): string {
  const payload: SessionPayload = { email, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** scrypt password hash in `salt:hash` hex form (see scripts/hash-password.ts). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  const hash = Buffer.from(hashHex, "hex");
  const test = scryptSync(password, Buffer.from(saltHex, "hex"), hash.length);
  return hash.length === test.length && timingSafeEqual(hash, test);
}

// ── Server helpers ───────────────────────────────────────────────────────────
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verifySessionToken(store.get(COOKIE)?.value);
}

export async function setSessionCookie(email: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, createSessionToken(email), {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}
