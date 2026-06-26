import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arbor Lead Tracking",
  description: "Lead sources, calls, and ROI for Arbor Management.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
