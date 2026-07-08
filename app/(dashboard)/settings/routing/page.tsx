import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { DEFAULT_FORWARD_KEY } from "@/lib/routing";
import { RoutingForm } from "./routing-form";

export const dynamic = "force-dynamic";

export default async function RoutingPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const current = await getSetting<string | null>(DEFAULT_FORWARD_KEY, null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Routing</h1>
          <p className="page-sub">Where tracked calls forward by default · per-number overrides live in /numbers</p>
        </div>
      </div>

      <RoutingForm initial={current ?? ""} envFallback={env.TWILIO_DEFAULT_DESTINATION} />
    </>
  );
}
