"use client";

import { useLinkStatus } from "next/link";

/** Feedback also covers clicks before a route's loading shell is prefetched. */
export function NavigationPending() {
  const { pending } = useLinkStatus();
  return (
    <span className="ml-2 inline-flex h-3 w-3 shrink-0 items-center" role="status" aria-live="polite">
      {pending ? <>
        <span aria-hidden="true" className="h-3 w-3 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin" />
        <span className="sr-only">Opening section…</span>
      </> : null}
    </span>
  );
}
