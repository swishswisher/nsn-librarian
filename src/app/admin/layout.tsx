import type { ReactNode } from "react";
import { requireHumanSession } from "@/lib/auth/session";
export const dynamic = "force-dynamic";
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireHumanSession("/admin/library");
  return <>{children}</>;
}
