import { LibraryLoading } from "@/components/library/LibraryLoading";
import { LibraryQuickNav } from "@/components/library/LibraryQuickNav";

export default function Loading() {
  return <main className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-8"><LibraryQuickNav /><LibraryLoading /></main>;
}
