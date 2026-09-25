import Link from "next/link";

import { DocumentRelationshipReviewControls } from "@/components/library/DocumentRelationshipReviewControls";
import { IdentityCorrectionPanel } from "@/components/library/IdentityCorrectionPanel";
import { KnowledgeReviewPanel } from "@/components/library/KnowledgeReviewPanel";
import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getIdentityCorrectionCandidates, getPersistentIdentityGroups, getRecentPersistentFileRelationships } from "@/lib/bridge/persistent-knowledge";
import { getKnowledgeReviewPageData } from "@/lib/knowledge/queries";
import { getKnowledgeGraphRoute } from "@/lib/library/routes";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const [data, fileRelationships, identityGroups, correctionCandidates] = await Promise.all([
    getKnowledgeReviewPageData(),
    getRecentPersistentFileRelationships(),
    getPersistentIdentityGroups(),
    getIdentityCorrectionCandidates(),
  ]);
  const entityGroups = identityGroups.filter((group) => group.kind !== "DOCUMENT_FAMILY" && !group.kind.startsWith("UNRESOLVED_"));
  const unresolvedGroups = identityGroups.filter((group) => group.kind.startsWith("UNRESOLVED_"));
  const versionFamilies = identityGroups.filter((group) => group.kind === "DOCUMENT_FAMILY");
  const provisionalCount =
    data.objects.filter((object) => object.status === "PROVISIONAL").length +
    data.relationships.filter(
      (relationship) => relationship.status === "PROVISIONAL",
    ).length;
  const approvedCount = data.objects.filter(
    (object) => object.status === "APPROVED",
  ).length;

  return (
    <LibraryShell active="knowledge">
      <div className="grid min-w-0 gap-8">
        <NsnPageHeader
          description="The Knowledge Graph tracks recurring topics, frameworks, concepts, and relationships across the library. Only approved knowledge becomes trusted."
          eyebrow="Knowledge Graph"
          title="Topic Intelligence"
        >
          <Link
            className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)]"
            href={getKnowledgeGraphRoute()}
          >
            Open Graph View
          </Link>
        </NsnPageHeader>

        <NsnCard tone="aqua">
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)]">
            <div className="min-w-0">
              <p className="nsn-display break-words text-2xl leading-8 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                Files remain containers. Knowledge becomes the semantic layer.
              </p>
              <p className="mt-3 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                The Librarian can propose topics and relationships, but Deanne
                decides what becomes trusted. Rejected proposals stay preserved
                as history and are excluded from trusted reasoning.
              </p>
            </div>
            <dl className="grid gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 text-sm leading-6 text-[var(--nsn-slate)] sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-[var(--nsn-navy)]">
                  Needs review
                </dt>
                <dd>{provisionalCount}</dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--nsn-navy)]">
                  Trusted knowledge
                </dt>
                <dd>{approvedCount}</dd>
              </div>
            </dl>
          </div>
        </NsnCard>

        <KnowledgeReviewPanel
          mergeTargets={data.mergeTargets}
          objects={data.objects}
          relationships={data.relationships}
        />

        {correctionCandidates.length > 1 ? <IdentityCorrectionPanel candidates={correctionCandidates} /> : null}

        {entityGroups.length > 0 ? (
          <section className="grid min-w-0 gap-3">
            <div>
              <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">Recognized identities</h2>
              <p className="mt-1 text-sm text-[var(--nsn-slate)]">Explicit document markers suggest a person, client, organization, project, or event. A single file is not proof of a broader relationship.</p>
            </div>
            <ul className="grid min-w-0 gap-3 md:grid-cols-2">
              {entityGroups.map((group) => (
                <li className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 text-sm text-[var(--nsn-slate)]" key={group.id}>
                  <h3 className="font-semibold text-[var(--nsn-navy)]">{group.kind.toLowerCase().replaceAll("_", " ")} in {group.libraryName}</h3>
                  <p>{group.humanConfirmed ? "Deanne connected these files after review." : group.members.length > 1 ? "These files share explicit identity markers. Matching names alone are not enough." : "This file contains an explicit identity marker; no other file is linked yet."}</p>
                  {group.contextFiles.length > 0 ? <p className="break-words [overflow-wrap:anywhere]">Client or project context: {group.contextFiles.join(", ")}</p> : null}
                  <ul className="grid gap-1 pl-4">
                    {group.members.map((member) => (
                      <li className="list-disc break-words [overflow-wrap:anywhere]" key={member.fileKey}>
                        {member.relativePath}
                        {member.sourceRanges.length ? ` (source characters ${member.sourceRanges.map((range) => `${range.start}-${range.end}`).join(", ")})` : ""}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {unresolvedGroups.length > 0 ? (
          <section className="grid min-w-0 gap-3">
            <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">Names needing context</h2>
            <ul className="grid min-w-0 gap-3 md:grid-cols-2">
              {unresolvedGroups.map((group) => <li className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 text-sm text-[var(--nsn-slate)]" key={group.id}>
                <p className="font-semibold text-[var(--nsn-navy)]">{group.kind === "UNRESOLVED_CLIENT" ? "Client mention" : "Project mention"} in {group.libraryName}</p>
                <p className="break-words [overflow-wrap:anywhere]">{group.members[0].relativePath}</p>
                <p>There is not enough evidence to connect this name to another file.</p>
              </li>)}
            </ul>
          </section>
        ) : null}

        {versionFamilies.length > 0 ? (
          <section className="grid min-w-0 gap-3">
            <div>
              <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">Document versions</h2>
              <p className="mt-1 text-sm text-[var(--nsn-slate)]">These families require an explicit document identity, title, and revision evidence. Identical copies remain separate files.</p>
            </div>
            <ul className="grid min-w-0 gap-3 md:grid-cols-2">
              {versionFamilies.map((family) => (
                <li className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 text-sm text-[var(--nsn-slate)]" key={family.id}>
                  <h3 className="font-semibold text-[var(--nsn-navy)]">Possible version family in {family.libraryName}</h3>
                  <p>{family.latestKey ? "One version has the strongest explicit ordering evidence." : "The latest version is unclear from the available evidence."}</p>
                  <ul className="grid gap-1 pl-4">
                    {family.members.map((member) => (
                      <li className="list-disc break-words [overflow-wrap:anywhere]" key={member.fileKey}>
                        {member.relativePath}{member.revisionNumber ? `, revision ${member.revisionNumber}` : ""}{member.revisionDate ? `, dated ${member.revisionDate}` : ""}{family.latestKey === member.fileKey ? " (latest candidate, not confirmed)" : ""}
                      </li>
                    ))}
                  </ul>
                  <p>No files are replaced or removed because of this grouping.</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {fileRelationships.length > 0 ? (
          <section className="grid min-w-0 gap-3">
            <div>
              <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">Related library items</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">These are source-backed connections across scans, not approved Memory or instructions to move files.</p>
            </div>
            <ul className="grid min-w-0 gap-3 md:grid-cols-2">
              {fileRelationships.map((relationship) => (
                <li className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 text-sm text-[var(--nsn-slate)]" key={relationship.id}>
                  <p className="text-xs font-semibold text-[var(--nsn-slate)]">{relationship.libraryName}</p>
                  <p className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">{relationship.sourceRelativePath} and {relationship.targetRelativePath}</p>
                  <p>{relationship.relationshipKind === "PROBABLE_REVISION" ? "Possible revisions" : relationship.relationshipKind === "BELONGS_TO_PROJECT" ? "Human-corrected project relationship" : relationship.relationshipKind?.startsWith("SAME_") ? `Possible same ${relationship.relationshipKind.slice(5).toLowerCase()}` : "Related subjects"}</p>
                  <p>{relationship.status === "CONFIRMED" ? "Human confirmed" : relationship.status === "REJECTED" ? "Deanne marked these as separate" : relationship.status === "ARCHIVED" ? "Historical, no longer current" : "Provisional, needs review"}</p>
                  {relationship.supportingTopics.length > 0 ? <p>Shared subjects: {relationship.supportingTopics.join(", ").replaceAll("-", " ")}</p> : null}
                  <p>{relationship.evidenceKinds.includes("HUMAN_REVIEW") ? "Based on Deanne's correction" : relationship.evidenceKinds.includes("CONTENT") ? "Direct document evidence" : relationship.evidenceKinds.includes("TRUSTED_OBSERVATION") ? "Reviewed observation evidence" : "Inferred relationship"}</p>
                  {relationship.sourceRanges.length > 0 || relationship.targetRanges.length > 0 ? (
                    <p className="text-xs">Verified source locations: {relationship.sourceRanges.map((range) => `${relationship.sourceRelativePath} characters ${range.start}-${range.end}`).concat(relationship.targetRanges.map((range) => `${relationship.targetRelativePath} characters ${range.start}-${range.end}`)).join("; ")}</p>
                  ) : null}
                  {relationship.decisions.length > 0 ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer font-semibold">Review history</summary>
                      <ul className="mt-1 grid gap-1 pl-4">
                        {relationship.decisions.map((decision) => <li className="list-disc" key={`${decision.createdAt}-${decision.action}`}>{decision.action.toLowerCase()} on {new Date(decision.createdAt).toLocaleDateString("en-US")}{decision.note ? `: ${decision.note}` : ""}</li>)}
                      </ul>
                    </details>
                  ) : null}
                  {relationship.reviewable ? <DocumentRelationshipReviewControls id={relationship.id} kind={relationship.relationshipKind} status={relationship.status} /> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </LibraryShell>
  );
}
