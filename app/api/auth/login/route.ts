import { z } from "zod";
import { env } from "@/lib/env";
import { setSessionCookie, verifyPassword } from "@/lib/auth";

export const runtime = "nodejs";

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "invalid input" }, { status: 400 });
  }
  const { email, password } = parsed.data;

  const emailOk = email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
  const passOk = verifyPassword(password, env.ADMIN_PASSWORD_HASH);
  if (!emailOk || !passOk) {
    return Response.json({ error: "invalid credentials" }, { status: 401 });
  }

  await setSessionCookie(env.ADMIN_EMAIL);
  return Response.json({ ok: true });
}
