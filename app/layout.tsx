import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arbor Lead Tracking",
  description: "Lead sources, calls, and ROI for Arbor Management.",
  icons: { icon: "/favicon-32x32.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* data-palette: validated categorical series for charts (revenue, spend) */}
      <body data-palette="#2ea043,#4c8dff">{children}</body>
    </html>
  );
}
