import { redirect } from "next/navigation";

// ROI is now folded into the Sources hub (performance by source lives there).
export default function RoiPage() {
  redirect("/sources");
}
