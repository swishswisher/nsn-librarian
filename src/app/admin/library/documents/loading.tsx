import { LibraryLoading } from "@/components/library/LibraryLoading";
import { LibraryShell } from "@/components/library/LibraryShell";

export default function Loading() {
  return (
    <LibraryShell active="documents" bridgeLabel="Checking connection…" bridgeTone="source">
      <LibraryLoading />
    </LibraryShell>
  );
}
