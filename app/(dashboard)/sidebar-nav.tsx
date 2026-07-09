"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV: Array<{ href: string; label: string; ic: string; section?: string }> = [
  { href: "/", label: "Overview", ic: "◧" },
  { href: "/leads", label: "Inbox", ic: "✉" },
  { href: "/calls", label: "Calls", ic: "☎" },
  { href: "/sources", label: "Sources", ic: "◈" },
  { href: "/roi", label: "ROI", ic: "％" },
  { href: "/spend", label: "Spend", ic: "＄" },
  { href: "/numbers", label: "Numbers", ic: "#" },
  { href: "/settings", label: "Settings", ic: "⚙", section: "Admin" },
  { href: "/settings/integrations", label: "Integrations", ic: "◱" },
];

export function SidebarNav() {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));

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
