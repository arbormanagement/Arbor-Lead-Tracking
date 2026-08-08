import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CampaignsClient } from "./campaigns-client";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Campaigns</h1>
          <p className="page-sub">Which ad campaigns count as customer acquisition.</p>
        </div>
      </div>
      <CampaignsClient />
    </>
  );
}
