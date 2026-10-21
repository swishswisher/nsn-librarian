import Link from "next/link";
import { NavigationPending } from "@/components/library/NavigationPending";

export type LibrarySection = "overview" | "batches" | "connected-libraries" | "documents" | "monitoring" | "review" | "notebook" | "knowledge" | "memory" | "taxonomy" | "migration" | "history";
type Props = { active: LibrarySection };
const groups: Array<{ label: string; items: Array<{ label: string; href: string; section: LibrarySection }> }> = [
  { label: "Work", items: [
    { label: "Home", href: "/admin/library", section: "overview" },
    { label: "Notebook", href: "/admin/library/notebook", section: "notebook" },
    { label: "Library", href: "/admin/library/documents", section: "documents" },
  ] },
  { label: "Review", items: [
    { label: "Recommendations", href: "/admin/library/review", section: "review" },
    { label: "Organization Plans", href: "/admin/library/migration", section: "migration" },
  ] },
  { label: "Understanding", items: [
    { label: "Knowledge", href: "/admin/library/knowledge", section: "knowledge" },
    { label: "Memory", href: "/admin/library/memory", section: "memory" },
  ] },
  { label: "Connections", items: [
    { label: "Connected Libraries", href: "/admin/library/connected-libraries", section: "connected-libraries" },
    { label: "Monitoring", href: "/admin/library/monitoring", section: "monitoring" },
    { label: "Activity", href: "/admin/library/history", section: "history" },
  ] },
];

export function LibraryNavigation({ active }: Props) {
  return <nav aria-label="Library sections" className="nsn-navigation">
    {groups.map(group => <div className="nsn-nav-group" key={group.label}>
      <p className="nsn-nav-label">{group.label}</p>
      <ul>{group.items.map(item => <li key={item.href}>
        <Link href={item.href} aria-current={active === item.section ? "page" : undefined} className="nsn-nav-link">
          {item.label}<NavigationPending />
        </Link>
      </li>)}</ul>
    </div>)}
    <div className="nsn-nav-utilities">
      <Link href="/admin/library/taxonomy" className="nsn-nav-link" aria-current={active === "taxonomy" ? "page" : undefined}>Library Map</Link>
      <Link href="/connect-this-mac" className="nsn-nav-link">Mac setup</Link>
    </div>
  </nav>;
}
export function NsnSidebar({ active }: Props) {
  return <aside className="nsn-sidebar">
    <Link href="/admin/library" className="nsn-brand" aria-label="NSN Librarian home"><span>NSN</span><small>LIBRARIAN</small></Link>
    <LibraryNavigation active={active} />
  </aside>;
}
