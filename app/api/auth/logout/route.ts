import { clearSessionCookie } from "@/lib/auth";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function POST() {
  await clearSessionCookie();
  // Redirect back to login so the form-based logout lands somewhere sensible.
  return Response.redirect(new URL("/login", env.APP_BASE_URL), 303);
}
