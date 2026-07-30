import { redirect } from "next/navigation";

import { getScanSessionsRoute } from "@/lib/library/routes";

export const dynamic = "force-dynamic";

export default function LibraryBatchesCompatibilityPage() {
  redirect(getScanSessionsRoute());
}
