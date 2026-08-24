import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { OAUTH_SCOPE, verifyClientId } from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";

/**
 * OAuth consent — the one human step in connecting Claude to this app's data.
 *
 * Session-gated by the app's existing admin login: an unauthenticated visit
 * bounces to /login and returns here with the full query intact (the
 * middleware's presence gate drops query strings, so this page is excluded
 * from it and does its own authoritative check). Approving posts to
 * /api/oauth/approve, which re-validates everything and issues the code.
 *
 * The redirect target is shown on the card deliberately: DCR is open, so the
 * consent screen is the layer where a crafted link must become visible. The
 * allowlist in lib/mcp-oauth.ts already bounds where a code can go; showing it
 * is defense in depth, and for loopback redirects the MCP spec requires it.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;

  const session = await getSession();
  if (!session) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v != null) q.set(k, v);
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${q.toString()}`)}`);
  }

  const clientId = sp.client_id ?? "";
  const redirectUri = sp.redirect_uri ?? "";
  const state = sp.state ?? "";
  const codeChallenge = sp.code_challenge ?? "";
  const scope = sp.scope || OAUTH_SCOPE;

  const registered = verifyClientId(clientId);
  const problems: string[] = [];
  if (!registered) problems.push("Unrecognized client_id — the client must register first (this happens automatically when Claude connects).");
  if (registered && !registered.includes(redirectUri)) problems.push("redirect_uri does not match the client's registration.");
  if (sp.response_type !== "code") problems.push("response_type must be 'code'.");
  if (!codeChallenge) problems.push("A PKCE code_challenge is required.");
  if (sp.code_challenge_method && sp.code_challenge_method !== "S256") problems.push("code_challenge_method must be S256.");

  if (problems.length > 0) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>Can&apos;t connect</h1>
          <p className="muted" style={{ fontSize: 13 }}>
            This authorization request is not valid:
          </p>
          <ul className="muted" style={{ fontSize: 13, paddingLeft: 18 }}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  const target = new URL(redirectUri);
  const denyUrl = new URL(redirectUri);
  denyUrl.searchParams.set("error", "access_denied");
  if (state) denyUrl.searchParams.set("state", state);

  return (
    <div className="login-wrap">
      <form className="login-card" method="POST" action="/api/oauth/approve">
        <h1>Connect Claude</h1>
        <p style={{ fontSize: 13.5, lineHeight: 1.5 }}>
          A Claude client is asking to use the lead-tracking tools as you: read every dashboard
          number, reply to inbox threads by text, and run syncs.
        </p>
        <p className="muted" style={{ fontSize: 12.5 }}>
          After approval it returns to <strong>{target.host}</strong>
          {target.host !== "claude.ai" && " — a local Claude Code session on this machine"}.
        </p>
        <input type="hidden" name="client_id" value={clientId} />
        <input type="hidden" name="redirect_uri" value={redirectUri} />
        <input type="hidden" name="state" value={state} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="scope" value={scope} />
        <button type="submit">Approve</button>
        <p style={{ textAlign: "center", margin: "10px 0 0" }}>
          <a className="link muted" style={{ fontSize: 12.5 }} href={denyUrl.toString()}>
            Deny
          </a>
        </p>
      </form>
    </div>
  );
}
