import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/leads", label: "Leads" },
  { href: "/calls", label: "Calls" },
  { href: "/roi", label: "ROI" },
  { href: "/spend", label: "Spend" },
  { href: "/numbers", label: "Numbers" },
  { href: "/settings", label: "Settings" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Authoritative session check (Node runtime) — middleware is only a presence gate.
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          Arbor
          <small>Lead Tracking &amp; ROI</small>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href}>
              {n.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
