import { z } from "zod";
import { getSession } from "@/lib/auth";
import { credentialEncryptionAvailable } from "@/lib/crypto";
import { credentialStatus, getSpec, setCredential } from "@/lib/credentials";

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
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

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

  const allowed = new Set(spec.fields.map((f) => f.key));
  try {
    for (const [key, value] of Object.entries(parsed.data.values)) {
      if (!allowed.has(key)) continue; // ignore stray keys
      await setCredential(spec.platform, key, value.trim());
    }
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
