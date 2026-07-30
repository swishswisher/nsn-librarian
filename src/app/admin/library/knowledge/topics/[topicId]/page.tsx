import Link from "next/link";
import { notFound } from "next/navigation";

import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import {
  formatKnowledgeRelationshipType,
  isOrganizationHistoryRelationshipType,
  knowledgeRelationshipProposalLabel,
  organizationHistoryLocationsFromEvidence,
} from "@/lib/knowledge/presentation";
import { getKnowledgeTopicPageData } from "@/lib/knowledge/queries";
import {
  getKnowledgeGraphRoute,
  getKnowledgeRoute,
  getKnowledgeTopicRoute,
} from "@/lib/library/routes";
import type {
  KnowledgeObjectSummary,
  KnowledgeRelationshipSummary,
  NotebookSourceLink,
} from "@/types/library";

export const dynamic = "force-dynamic";

type TopicPageProps = {
  params: Promise<{
    topicId: string;
  }>;
};

function formatDate(value: string | null) {
  if (!value) {
    return "Not approved yet";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(new Date(value));
}

function statusTone(status: string): NsnBadgeTone {
  if (status === "APPROVED") {
    return "approved";
  }

  if (status === "REJECTED" || status === "ARCHIVED") {
    return "review";
  }

  return "pending";
}

function confidenceLabel(value: number) {
  return `${Math.round(value * 100)}%`;
}

function RelationshipList({
  relationships,
  title,
}: {
  relationships: KnowledgeRelationshipSummary[];
  title: string;
}) {
  return (
    <section className="grid min-w-0 gap-3">
      <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">{title}</h2>
      {relationships.length > 0 ? (
        <div className="grid min-w-0 gap-3">
          {relationships.map((relationship) => {
            const isOrganizationHistory = isOrganizationHistoryRelationshipType(
              relationship.relationshipType,
            );
            const relationshipLabel = formatKnowledgeRelationshipType(
              relationship.relationshipType,
            );
            const locations = organizationHistoryLocationsFromEvidence(
              relationship.evidence,
            );

            return (
              <NsnCard className="min-w-0" key={relationship.id}>
                <div className="grid min-w-0 gap-3">
                  <div className="flex flex-wrap gap-2">
                    <NsnBadge tone={statusTone(relationship.status)}>
                      {relationship.status.toLowerCase()}
                    </NsnBadge>
                    <NsnBadge tone="migration">{relationshipLabel}</NsnBadge>
                    {isOrganizationHistory ? (
                      <NsnBadge tone="source">
                        Observed in organization history
                      </NsnBadge>
                    ) : null}
                  </div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--nsn-teal-dark)]">
                    {knowledgeRelationshipProposalLabel(relationship)}
                  </p>
                  <p className="break-words text-sm font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                    {relationship.sourceName} {relationshipLabel}{" "}
                    {relationship.targetName}
                  </p>
                  <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                    {relationship.explanation}
                  </p>
                  {isOrganizationHistory ? (
                    <dl className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 text-sm leading-6 text-[var(--nsn-slate)] sm:grid-cols-2">
                      <div className="min-w-0">
                        <dt className="font-semibold text-[var(--nsn-navy)]">
                          Current location:
                        </dt>
                        <dd className="break-words [overflow-wrap:anywhere]">
                          {locations.current ?? "Not recorded"}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="font-semibold text-[var(--nsn-navy)]">
                          Planned or completed location:
                        </dt>
                        <dd className="break-words [overflow-wrap:anywhere]">
                          {locations.plannedOrCompleted ?? "Not recorded"}
                        </dd>
                      </div>
                    </dl>
                  ) : null}
                  <p className="text-sm font-semibold text-[var(--nsn-teal-dark)]">
                    Confidence: {confidenceLabel(relationship.confidence)}
                  </p>
                </div>
              </NsnCard>
            );
          })}
        </div>
      ) : (
        <NsnEmptyState
          description="No relationship has been recorded in this direction yet."
          title="No relationships here yet"
        />
      )}
    </section>
  );
}

function RelatedObjects({ objects }: { objects: KnowledgeObjectSummary[] }) {
  if (objects.length === 0) {
    return null;
  }

  return (
    <section className="grid min-w-0 gap-3">
      <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
        How it connects
      </h2>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        {objects.map((object) => (
          <Link
            className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 transition hover:bg-[var(--nsn-sage-mist)]"
            href={getKnowledgeTopicRoute(object.id)}
            key={object.id}
          >
            <div className="flex flex-wrap gap-2">
              <NsnBadge tone={statusTone(object.status)}>
                {object.status.toLowerCase()}
              </NsnBadge>
              <NsnBadge tone="source">{object.objectType.toLowerCase()}</NsnBadge>
            </div>
            <p className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
              {object.name}
            </p>
            <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {object.description}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}

function SourceLinks({ links }: { links: NotebookSourceLink[] }) {
  if (links.length === 0) {
    return null;
  }

  return (
    <section className="grid min-w-0 gap-3">
      <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
        Related reflections
      </h2>
      <div className="flex min-w-0 flex-wrap gap-2">
        {links.map((link) => (
          <Link
            className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] [overflow-wrap:anywhere]"
            href={link.href}
            key={`${link.kind}-${link.href}`}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </section>
  );
}

export default async function KnowledgeTopicPage({ params }: TopicPageProps) {
  const { topicId } = await params;
  const data = await getKnowledgeTopicPageData(topicId);

  if (!data) {
    notFound();
  }

  const topic = data.object;

  return (
    <LibraryShell active="knowledge">
      <div className="grid min-w-0 gap-8">
        <NsnPageHeader
          description="A topic page shows what the Librarian noticed, where it appears, and what Deanne has reviewed."
          eyebrow="Topic Intelligence"
          subtitle={`${topic.objectType.toLowerCase()} - ${topic.status.toLowerCase()}`}
          title={topic.name}
        >
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)]"
              href={getKnowledgeRoute()}
            >
              Review Knowledge
            </Link>
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
              href={getKnowledgeGraphRoute()}
            >
              Open Graph
            </Link>
          </div>
        </NsnPageHeader>

        <NsnCard tone="aqua">
          <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)]">
            <section className="min-w-0">
              <div className="flex flex-wrap gap-2">
                <NsnBadge tone={statusTone(topic.status)}>
                  {topic.status.toLowerCase()}
                </NsnBadge>
                <NsnBadge tone={topic.trustLevel === "HUMAN_APPROVED" ? "approved" : "pending"}>
                  {topic.trustLevel === "HUMAN_APPROVED"
                    ? "Trusted"
                    : topic.trustLevel === "EXCLUDED"
                      ? "Excluded"
                      : "Needs review"}
                </NsnBadge>
              </div>
              <h2 className="nsn-display mt-4 text-2xl text-[var(--nsn-navy)]">
                What this topic means
              </h2>
              <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {topic.description}
              </p>
            </section>
            <dl className="grid gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 text-sm leading-6 text-[var(--nsn-slate)] sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-[var(--nsn-navy)]">
                  First seen
                </dt>
                <dd>{formatDate(topic.firstSeen)}</dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--nsn-navy)]">
                  Last seen
                </dt>
                <dd>{formatDate(topic.lastSeen)}</dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--nsn-navy)]">
                  Related files
                </dt>
                <dd>{topic.evidence.relatedFiles.length}</dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--nsn-navy)]">
                  Reflections
                </dt>
                <dd>{topic.evidence.relatedNotebookEntryIds.length}</dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--nsn-navy)]">
                  Confidence
                </dt>
                <dd>{confidenceLabel(topic.confidence)}</dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--nsn-navy)]">
                  Approved
                </dt>
                <dd>{formatDate(topic.approvedAt)}</dd>
              </div>
            </dl>
          </div>
        </NsnCard>

        <div className="grid min-w-0 gap-5 xl:grid-cols-2">
          <NsnCard className="min-w-0">
            <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
              Where it appears
            </h2>
            {topic.evidence.appearedIn.length > 0 ? (
              <ul className="mt-3 grid gap-2 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
                {topic.evidence.appearedIn.map((item) => (
                  <li
                    className="list-disc break-words [overflow-wrap:anywhere]"
                    key={item}
                  >
                    {item}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm leading-7 text-[var(--nsn-slate)]">
                The Librarian has not recorded detailed locations yet.
              </p>
            )}
          </NsnCard>

          <NsnCard className="min-w-0">
            <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
              What the Librarian noticed
            </h2>
            <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {topic.provenanceSummary}
            </p>
            {topic.evidence.whyProposed.length > 0 ? (
              <ul className="mt-3 grid gap-2 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
                {topic.evidence.whyProposed.map((item) => (
                  <li
                    className="list-disc break-words [overflow-wrap:anywhere]"
                    key={item}
                  >
                    {item}
                  </li>
                ))}
              </ul>
            ) : null}
          </NsnCard>
        </div>

        <RelatedObjects objects={data.relatedObjects} />
        <RelationshipList
          relationships={data.outgoingRelationships}
          title="Related concepts and frameworks"
        />
        <RelationshipList
          relationships={data.incomingRelationships}
          title="Related projects, workshops, and recommendations"
        />
        <SourceLinks links={data.sourceLinks} />

        <section className="grid min-w-0 gap-3">
          <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
            How it has changed over time
          </h2>
          <NsnCard className="min-w-0">
            {data.revisions.length > 0 ? (
              <ol className="grid gap-3">
                {data.revisions.map((revision) => (
                  <li
                    className="grid min-w-0 gap-1 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 text-sm leading-6 text-[var(--nsn-slate)]"
                    key={revision.id}
                  >
                    <p className="font-semibold text-[var(--nsn-navy)]">
                      {revision.actionType.replaceAll("_", " ").toLowerCase()}
                    </p>
                    <p>{formatDate(revision.createdAt)}</p>
                    {revision.note ? (
                      <p className="break-words [overflow-wrap:anywhere]">
                        {revision.note}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm leading-7 text-[var(--nsn-slate)]">
                No human revisions have been recorded yet.
              </p>
            )}
          </NsnCard>
        </section>
      </div>
    </LibraryShell>
  );
}
