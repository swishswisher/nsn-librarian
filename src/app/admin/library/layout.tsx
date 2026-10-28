import type { ReactNode } from "react";
import { BridgeConnectionProvider } from "@/components/library/BridgeConnectionStatus";
import { KnowledgeRefreshProvider } from "@/components/library/KnowledgeRefreshStatus";

export default function LibraryLayout({ children }: { children: ReactNode }) {
  return <BridgeConnectionProvider><KnowledgeRefreshProvider>{children}</KnowledgeRefreshProvider></BridgeConnectionProvider>;
}
