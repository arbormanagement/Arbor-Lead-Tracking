import { z } from "zod";
import { env } from "@/lib/env";
import { setSessionCookie, verifyPassword } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  // Brute-force guard: 10 attempts/min per IP. Cheap check before any scrypt work.
  const limit = rateLimit(`login:${clientIp(req)}`, 10, 60_000);
  if (!limit.ok) {
    return Response.json(
      { error: "too many attempts, try again shortly" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "invalid input" }, { status: 400 });
  }
  const { email, password } = parsed.data;

  // Always run the (async) verify even on an email mismatch — no user enumeration
  // via response timing.
  const emailOk = email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
  const passOk = await verifyPassword(password, env.ADMIN_PASSWORD_HASH);
  if (!emailOk || !passOk) {
    return Response.json({ error: "invalid credentials" }, { status: 401 });
  }

  await setSessionCookie(env.ADMIN_EMAIL);
  return Response.json({ ok: true });
}
