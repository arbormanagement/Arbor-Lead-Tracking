"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV: Array<{ href: string; label: string; ic: string; section?: string }> = [
  { href: "/", label: "Overview", ic: "◧" },
  { href: "/calls", label: "Calls", ic: "☎" },
  { href: "/leads", label: "Leads", ic: "✉" },
  { href: "/sources", label: "Sources", ic: "◈" },
  { href: "/numbers", label: "Numbers", ic: "#" },
  { href: "/settings", label: "Settings", ic: "⚙", section: "Admin" },
  { href: "/settings/integrations", label: "Integrations", ic: "◱" },
  { href: "/spend", label: "Data & sync", ic: "⟳" },
];

export function SidebarNav() {
  const path = usePathname();

  // Most-specific match wins: a nav item is active only if it's the longest
  // href that prefixes the current path. Without this, /settings/integrations
  // would light up both "Settings" (via startsWith) and "Integrations".
  const matchLen = (href: string) =>
    href === "/" ? (path === "/" ? 1 : -1) : path === href || path.startsWith(href + "/") ? href.length : -1;
  const best = Math.max(...NAV.map((n) => matchLen(n.href)));
  const isActive = (href: string) => best >= 0 && matchLen(href) === best;

  return (
    <nav className="nav">
      {NAV.map((n) => (
        <div key={n.href}>
          {n.section && <div className="section">{n.section}</div>}
          <Link href={n.href} className={isActive(n.href) ? "active" : ""}>
            <span className="ic">{n.ic}</span>
            {n.label}
          </Link>
        </div>
      ))}
    </nav>
  );
}
