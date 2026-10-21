import { getHumanSession } from "@/lib/auth/session";

export async function LibraryAccount() {
  const session = await getHumanSession();
  if (!session) return null;
  const initials = session.name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join("");
  return <details className="nsn-account">
    <summary aria-label="Account and sign out"><span className="nsn-account-avatar" aria-hidden="true" style={session.picture ? { backgroundImage: `url(${JSON.stringify(session.picture)})` } : undefined}>{session.picture ? null : initials || "NSN"}</span><span className="nsn-account-name">{session.name}</span></summary>
    <div className="nsn-account-panel"><p>{session.name}</p><small>{session.role === "OWNER" ? "Owner" : "Approved librarian"}</small><form action="/api/auth/logout" method="post"><button className="nsn-menu-trigger" type="submit">Sign out</button></form></div>
  </details>;
}
