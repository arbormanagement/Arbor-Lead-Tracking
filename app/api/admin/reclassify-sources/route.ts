import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { reclassifyUnmappedSources } from "@/lib/sources/reclassify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Move leads off `other` once `classifySource` learns a channel it previously did
 * not recognise. See lib/sources/reclassify.ts for what it does and why it can only
 * ever move a lead OFF `other`.
 *
 * A route as well as a script (`npm run db:reclassify-sources`) because there is no
 * other way to run it against production: the Railway Postgres has no public TCP
 * proxy, so nothing outside the project's private network can reach the database,
 * and a shell on the web service is not part of how this app is operated. The same
 * reasoning that made /api/leads the reachable check for the conversion-export
 * question applies here.
 *
 * GET  → dry run, always. Safe to hit from a browser with the admin session.
 * POST → dry run too, unless `?apply=true`. Writing needs BOTH a POST and the flag,
 *        so neither a stray link nor a mistyped query string can rewrite leads.
 */
export async function GET(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();
  return Response.json(await reclassifyUnmappedSources({ apply: false }));
}

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const apply = new URL(req.url).searchParams.get("apply") === "true";
  return Response.json(await reclassifyUnmappedSources({ apply }));
}
