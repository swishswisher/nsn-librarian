import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { MindPreviewButton } from "@/components/library/MindPreviewButton";
import { NsnTableShell } from "@/components/library/NsnTableShell";
import type { LibraryDocumentSummary } from "@/types/library";

type DocumentTableProps = {
  documents: LibraryDocumentSummary[];
  highlightedDocumentId?: string | null;
};

function statusTone(status: string): NsnBadgeTone {
  if (status === "COMPLETED" || status === "CLASSIFIED" || status === "APPROVED") {
    return "approved";
  }

  if (
    status === "FAILED" ||
    status === "NEEDS_REVIEW" ||
    status === "IN_REVIEW" ||
    status === "UNSUPPORTED"
  ) {
    return "review";
  }

  if (status === "PENDING" || status === "EXTRACTING") {
    return "pending";
  }

  return "unknown";
}

function readingStatusLabel(status: string) {
  if (status === "COMPLETED") {
    return "Read";
  }

  if (status === "FAILED") {
    return "Needs attention";
  }

  if (status === "UNSUPPORTED") {
    return "Not supported yet";
  }

  if (status === "EXTRACTING") {
    return "Reading";
  }

  return "Waiting";
}

function fileTypeLabel(document: LibraryDocumentSummary) {
  if (document.extension) {
    return document.extension.toUpperCase();
  }

  return document.mimeType ?? "Unknown";
}

function wordCountLabel(wordCount: number | null) {
  if (wordCount === null) {
    return "Not read yet";
  }

  return new Intl.NumberFormat("en-US").format(wordCount);
}

function DocumentMobileCard({
  document,
  isHighlighted,
}: {
  document: LibraryDocumentSummary;
  isHighlighted: boolean;
}) {
  return (
    <article
      className={[
        "min-w-0 overflow-hidden rounded-lg border bg-[var(--nsn-card)] p-3 shadow-[0_12px_28px_rgb(31_42_68_/_0.05)] sm:p-4",
        isHighlighted
          ? "border-[var(--nsn-teal)] ring-2 ring-[var(--nsn-soft-aqua)]"
          : "border-[var(--nsn-border)]",
      ].join(" ")}
    >
      <div className="grid gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--nsn-warm-gray)]">
            Library Item
          </p>
          <h3 className="mt-1 min-w-0 break-words text-sm font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
            {document.originalFileName}
          </h3>
        </div>

        <div className="flex flex-wrap gap-2">
          <NsnBadge tone="source">{fileTypeLabel(document)}</NsnBadge>
          <NsnBadge tone={statusTone(document.extractionStatus)}>
            {readingStatusLabel(document.extractionStatus)}
          </NsnBadge>
          {document.relatedItemCount > 0 ? (
            <NsnBadge tone="migration">
              Related Items: {document.relatedItemCount}
            </NsnBadge>
          ) : null}
          {isHighlighted ? (
            <NsnBadge tone="approved">Recently examined</NsnBadge>
          ) : null}
        </div>

        <dl className="grid gap-3 text-sm text-[var(--nsn-slate)]">
          <div>
            <dt className="font-semibold text-[var(--nsn-navy)]">Scan Session</dt>
            <dd className="mt-1 break-words [overflow-wrap:anywhere]">
              {document.scanSessionName}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-[var(--nsn-navy)]">Words</dt>
            <dd className="mt-1">{wordCountLabel(document.wordCount)}</dd>
          </div>
          <div>
            <dt className="font-semibold text-[var(--nsn-navy)]">Preview</dt>
            <dd className="mt-1 break-words leading-6 [overflow-wrap:anywhere]">
              {document.previewText ?? "No readable preview yet."}
            </dd>
          </div>
        </dl>

        <div className="min-w-0">
          <MindPreviewButton
            canObserve={document.canObserve}
            documentId={document.id}
            itemTitle={document.originalFileName}
          />
        </div>
      </div>
    </article>
  );
}

export function DocumentTable({
  documents,
  highlightedDocumentId = null,
}: DocumentTableProps) {
  if (documents.length === 0) {
    return (
      <NsnEmptyState
        description="Choose what you want the Librarian to examine. Library items will appear here after a scan session begins."
        title="No library items yet"
      />
    );
  }

  return (
    <section aria-labelledby="document-table-heading" className="min-w-0">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2
            className="nsn-display text-2xl text-[var(--nsn-navy)]"
            id="document-table-heading"
          >
            My Library
          </h2>
          <p className="mt-1 text-sm text-[var(--nsn-slate)]">
            The Librarian can examine your library items. Observations and
            recommendations come next.
          </p>
        </div>
        <span className="text-sm text-[var(--nsn-warm-gray)]">
          {documents.length} library item{documents.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* No feature is complete if it breaks responsive behavior. */}
      <div className="grid min-w-0 gap-3 xl:hidden">
        {documents.map((document) => (
          <DocumentMobileCard
            document={document}
            isHighlighted={document.id === highlightedDocumentId}
            key={document.id}
          />
        ))}
      </div>

      <NsnTableShell className="hidden xl:block">
        <table className="nsn-table">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[14%]" />
            <col className="w-[8%]" />
            <col className="w-[12%]" />
            <col className="w-[8%]" />
            <col className="w-[26%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead>
            <tr>
              <th>Library Item</th>
              <th>Scan Session</th>
              <th>Type</th>
              <th>Reading Status</th>
              <th>Words</th>
              <th>Preview</th>
              <th>Examine</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => (
              <tr
                className={
                  document.id === highlightedDocumentId
                    ? "bg-[var(--nsn-sage-mist)]"
                    : undefined
                }
                key={document.id}
              >
                <td className="min-w-0 break-words font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  <div className="grid gap-2">
                    <span>{document.originalFileName}</span>
                    {document.relatedItemCount > 0 ? (
                      <NsnBadge tone="migration">
                        Related Items: {document.relatedItemCount}
                      </NsnBadge>
                    ) : null}
                    {document.id === highlightedDocumentId ? (
                      <NsnBadge tone="approved">Recently examined</NsnBadge>
                    ) : null}
                  </div>
                </td>
                <td className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {document.scanSessionName}
                </td>
                <td>
                  <NsnBadge tone="source">{fileTypeLabel(document)}</NsnBadge>
                </td>
                <td>
                  <NsnBadge tone={statusTone(document.extractionStatus)}>
                    {readingStatusLabel(document.extractionStatus)}
                  </NsnBadge>
                </td>
                <td className="break-words">{wordCountLabel(document.wordCount)}</td>
                <td className="min-w-0 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  {document.previewText ?? "No readable preview yet."}
                </td>
                <td>
                  <MindPreviewButton
                    canObserve={document.canObserve}
                    documentId={document.id}
                    itemTitle={document.originalFileName}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </NsnTableShell>
    </section>
  );
}
