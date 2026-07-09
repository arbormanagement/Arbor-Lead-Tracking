import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { FormsClient } from "./forms-client";

export const dynamic = "force-dynamic";

export default async function FacebookFormsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Facebook lead forms</h1>
          <p className="page-sub">Choose which lead forms are pulled into the inbox as customer leads</p>
        </div>
      </div>
      <FormsClient />
    </>
  );
}
