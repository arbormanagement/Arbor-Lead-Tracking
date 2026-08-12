import { z } from "zod";
import { authorizeAdmin, forbidden, unauthorized } from "@/lib/admin-auth";
import { credentialEncryptionAvailable } from "@/lib/crypto";
import { credentialStatus, getSpec, setCredential } from "@/lib/credentials";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";

/**
 * Save integration credentials (admin-gated). Values are envelope-encrypted before
 * they touch the DB; an empty string clears a field (falls back to env). Plaintext
 * is never returned — the response carries only masked status.
 */
const Body = z.object({
  platform: z.string(),
  values: z.record(z.string(), z.string()),
});

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  if (!credentialEncryptionAvailable()) {
    return Response.json(
      { error: "CREDENTIALS_ENCRYPTION_KEY is not set — cannot store credentials in the database" },
      { status: 400 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const spec = getSpec(parsed.data.platform);
  if (!spec) return Response.json({ error: "unknown platform" }, { status: 400 });

  // A machine token may CLEAR a credential but never set one. The asymmetry is the
  // point: clearing can only fall back to env, so the worst case is an integration
  // reverting to the value the deploy already trusts — while setting one could
  // silently repoint an integration at a different account, with the UI still
  // reporting every field as set. Same split `/api/numbers` draws between importing
  // an owned number and buying one.
  //
  // Clearing is the half worth automating, because the case that needs it is a
  // rotated CREDENTIALS_ENCRYPTION_KEY: every stored secret goes undecryptable at
  // once, and the repair is to delete rows that are already dead weight. Dull,
  // precise, and easy to get wrong by hand — an undecryptable row and a working one
  // look identical in Settings, so clearing the wrong field takes a live integration
  // down while looking exactly like the fix.
  if (auth.via === "token" && Object.values(parsed.data.values).some((v) => v.trim() !== "")) {
    return forbidden("token auth may only clear credentials; setting one requires a signed-in admin");
  }

  const allowed = new Set(spec.fields.map((f) => f.key));
  try {
    // One transaction for the whole set: a platform's fields are only meaningful
    // together (client_id with its refresh_token, key with its secret), so a
    // partial save is worse than no save.
    await db.transaction(async (tx) => {
      for (const [key, value] of Object.entries(parsed.data.values)) {
        if (!allowed.has(key)) continue; // ignore stray keys
        await setCredential(spec.platform, key, value.trim(), undefined, tx);
      }
    });
    return Response.json({ ok: true, status: await credentialStatus(spec.platform) });
  } catch (err) {
    // Most likely the integration_credentials table is missing (DB not migrated to
    // 0001). Surface a clear, actionable message instead of a silent 500 so the UI
    // doesn't just say "Save failed" with no cause.
    const detail = err instanceof Error ? err.message : String(err);
    const missingTable = /integration_credentials|relation .* does not exist|no such table/i.test(detail);
    return Response.json(
      {
        error: missingTable
          ? "Credential storage isn't set up yet — the database is missing the integration_credentials table. Run the DB migration, then try again."
          : `Could not save credentials: ${detail}`,
      },
      { status: 500 },
    );
  }
}
