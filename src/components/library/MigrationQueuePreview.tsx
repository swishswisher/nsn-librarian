import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { NsnTableShell } from "@/components/library/NsnTableShell";
import type { MigrationQueueRow } from "@/types/library";

type MigrationQueuePreviewProps = {
  items: MigrationQueueRow[];
};

function migrationStatusTone(status: string): NsnBadgeTone {
  if (status === "READY" || status === "COMPLETED") {
    return "approved";
  }

  if (status === "PENDING" || status === "IN_PROGRESS") {
    return "migration";
  }

  if (status === "BLOCKED" || status === "FAILED") {
    return "review";
  }

  return "unknown";
}

function migrationStatusLabel(status: string) {
  if (status === "READY") {
    return "Ready";
  }

  if (status === "IN_PROGRESS") {
    return "Organizing";
  }

  if (status === "COMPLETED") {
    return "Completed";
  }

  if (status === "FAILED" || status === "BLOCKED") {
    return "Needs attention";
  }

  return "Waiting";
}

function migrationActionLabel(actionType: string) {
  if (actionType === "COPY") {
    return "Copy file";
  }

  if (actionType === "MOVE") {
    return "Move file";
  }

  if (actionType === "LINK") {
    return "Link file";
  }

  if (actionType === "SKIP") {
    return "Leave unchanged";
  }

  return "Review";
}

export function MigrationQueuePreview({ items }: MigrationQueuePreviewProps) {
  if (items.length === 0) {
    return (
      <NsnEmptyState
        description="Approved organization plans will appear here before anything moves."
        title="No organization plans yet"
      />
    );
  }

  return (
    <section aria-labelledby="migration-preview-heading">
      <div className="mb-4">
        <h2
          className="nsn-display text-2xl text-[var(--nsn-navy)]"
          id="migration-preview-heading"
        >
          Organization Plans
        </h2>
        <p className="mt-1 text-sm text-[var(--nsn-slate)]">
          Review before organize. Nothing moves without approval.
        </p>
      </div>

      <NsnTableShell>
        <table className="nsn-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Action</th>
              <th>Status</th>
              <th>Suggested Home</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="font-semibold text-[var(--nsn-navy)]">
                  {item.fileName}
                </td>
                <td>
                  <NsnBadge tone="migration">
                    {migrationActionLabel(item.actionType)}
                  </NsnBadge>
                </td>
                <td>
                  <NsnBadge tone={migrationStatusTone(item.status)}>
                    {migrationStatusLabel(item.status)}
                  </NsnBadge>
                </td>
                <td className="min-w-64">{item.destinationPath}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </NsnTableShell>
    </section>
  );
}
