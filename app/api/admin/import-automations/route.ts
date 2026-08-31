import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { importAutomationsData } from "@/lib/reviews/import-automations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The import walks every source row one insert at a time; inert on Railway
// (no serverless ceiling) but declared for completeness.
export const maxDuration = 300;

/**
 * Run the Arbor-Automations data import from INSIDE the deployment — the only
 * place both databases are reachable: this app's Postgres has no public TCP
 * proxy, and the old app's gets a temporary Railway TCP proxy only for the
 * slice 4 cutover (create it, run this, delete it).
 *
 * The old database's URL comes in the JSON body (`{ old_database_url }`), not
 * an env var — it exists only for the minutes of the cutover, and a body dies
 * with the request instead of lingering in service config.
 *
 * GET  → always a dry run (connects, counts, samples — writes nothing).
 * POST → dry run too, unless `?apply=true`. Same double-gate as
 *        reclassify-sources: writing takes BOTH the method and the flag.
 */
async function run(req: Request, allowApply: boolean) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  let oldUrl: string | undefined;
  try {
    const body = (await req.json()) as { old_database_url?: string };
    oldUrl = body.old_database_url;
  } catch {
    // GET or empty body — handled below.
  }
  if (!oldUrl || !/^postgres(ql)?:\/\//.test(oldUrl)) {
    return Response.json(
      { error: "Pass { old_database_url: 'postgres://…' } in the JSON body" },
      { status: 400 },
    );
  }

  const apply = allowApply && new URL(req.url).searchParams.get("apply") === "true";
  try {
    return Response.json(await importAutomationsData({ oldUrl, apply }));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  return run(req, false);
}

export async function POST(req: Request) {
  return run(req, true);
}
