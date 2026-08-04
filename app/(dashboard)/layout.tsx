import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { SidebarNav } from "./sidebar-nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Authoritative session check (Node runtime) — middleware is only a presence gate.
  const session = await getSession();
  if (!session) redirect("/login");

  const email = session.email ?? "admin";
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="logo" src="/brand/arbor-logo.webp" alt="Arbor Management" />
          <div>
            <b>Arbor</b>
            <small>Lead Tracking</small>
          </div>
        </div>

        <SidebarNav />

        <div className="side-foot">
          <div className="avatar">{initials}</div>
          <div className="who">
            <b>{email}</b>
            <small>Owner</small>
          </div>
          {/* POST, not a link: the logout route is POST-only (a GET link would 405,
              and a GET handler would be CSRF-able via top-level navigation). */}
          <form method="post" action="/api/auth/logout" style={{ marginLeft: "auto" }}>
            <button
              className="logout"
              type="submit"
              title="Sign out"
              style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--faint)", fontSize: 12 }}
            >
              ⏻
            </button>
          </form>
        </div>
      </aside>

      <main className="main">
        <div className="pagewrap">{children}</div>
      </main>
    </div>
  );
}
