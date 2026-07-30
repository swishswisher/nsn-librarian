"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { getKnowledgeTopicRoute } from "@/lib/library/routes";
import {
  formatKnowledgeRelationshipType,
  isOrganizationHistoryRelationshipType,
  knowledgeRelationshipProposalLabel,
  organizationHistoryLocationsFromEvidence,
} from "@/lib/knowledge/presentation";
import type {
  KnowledgeGraphPageData,
  KnowledgeObjectStatus,
  KnowledgeObjectSummary,
  KnowledgeObjectType,
} from "@/types/library";

type GraphFilter = "ALL" | KnowledgeObjectType | KnowledgeObjectStatus;

const filterOptions: Array<{ label: string; value: GraphFilter }> = [
  { label: "All", value: "ALL" },
  { label: "Topics", value: "TOPIC" },
  { label: "Concepts", value: "CONCEPT" },
  { label: "Frameworks", value: "FRAMEWORK" },
  { label: "Projects", value: "PROJECT" },
  { label: "Workshops", value: "WORKSHOP" },
  { label: "Approved", value: "APPROVED" },
  { label: "Provisional", value: "PROVISIONAL" },
];

function statusTone(status: KnowledgeObjectStatus): NsnBadgeTone {
  if (status === "APPROVED") {
    return "approved";
  }

  if (status === "REJECTED" || status === "ARCHIVED") {
    return "review";
  }

  return "pending";
}

function objectMatchesFilter(object: KnowledgeObjectSummary, filter: GraphFilter) {
  if (filter === "ALL") {
    return true;
  }

  if (
    filter === "APPROVED" ||
    filter === "PROVISIONAL" ||
    filter === "REJECTED" ||
    filter === "ARCHIVED"
  ) {
    return object.status === filter;
  }

  return object.objectType === filter;
}

export function KnowledgeGraphExplorer({
  objects,
  relationships,
}: KnowledgeGraphPageData) {
  const [selectedObjectId, setSelectedObjectId] = useState(objects[0]?.id ?? "");
  const [activeFilter, setActiveFilter] = useState<GraphFilter>("ALL");
  const [showAllRelationships, setShowAllRelationships] = useState(false);
  const visibleObjects = useMemo(
    () => objects.filter((object) => objectMatchesFilter(object, activeFilter)),
    [activeFilter, objects],
  );
  const selectedObject =
    visibleObjects.find((object) => object.id === selectedObjectId) ??
    visibleObjects[0] ??
    null;
  const firstDegreeRelationships = selectedObject
    ? relationships.filter(
        (relationship) =>
          relationship.sourceObjectId === selectedObject.id ||
          relationship.targetObjectId === selectedObject.id,
      )
    : [];
  const relationshipList = showAllRelationships
    ? relationships
    : firstDegreeRelationships.slice(0, 12);

  if (objects.length === 0) {
    return (
      <NsnEmptyState
        description="Topics will appear after the Librarian has reviewed material to learn from."
        title="No knowledge graph yet"
      />
    );
  }

  return (
    <section className="grid min-w-0 gap-6" aria-labelledby="knowledge-graph">
      <div className="grid gap-4 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4">
        <div className="min-w-0">
          <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]" id="knowledge-graph">
            Relationship Explorer
          </h2>
          <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">
            Select one topic to see nearby relationships. Dense clusters are
            limited here so the view stays readable.
          </p>
        </div>
        <div
          aria-label="Graph filters"
          className="flex min-w-0 flex-wrap gap-2"
          role="group"
        >
          {filterOptions.map((filter) => (
            <button
              aria-pressed={activeFilter === filter.value}
              className={[
                "inline-flex min-h-10 max-w-full items-center justify-center rounded-md border px-3 text-center text-sm font-semibold transition",
                activeFilter === filter.value
                  ? "border-[var(--nsn-teal)] bg-[var(--nsn-teal)] text-[var(--nsn-white)]"
                  : "border-[var(--nsn-border)] bg-[var(--nsn-card)] text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]",
              ].join(" ")}
              key={filter.value}
              onClick={() => setActiveFilter(filter.value)}
              type="button"
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(16rem,0.35fr)_minmax(0,1fr)]">
        <NsnCard className="min-w-0">
          <h3 className="nsn-display text-xl text-[var(--nsn-navy)]">
            Select a topic
          </h3>
          <div className="mt-4 grid max-h-[32rem] min-w-0 gap-2 overflow-y-auto pr-1">
            {visibleObjects.slice(0, 60).map((object) => (
              <button
                aria-pressed={selectedObject?.id === object.id}
                className={[
                  "grid min-w-0 gap-1 rounded-md border p-3 text-left transition",
                  selectedObject?.id === object.id
                    ? "border-[var(--nsn-teal)] bg-[var(--nsn-soft-aqua)]"
                    : "border-[var(--nsn-border)] bg-[var(--nsn-card)] hover:bg-[var(--nsn-sage-mist)]",
                ].join(" ")}
                key={object.id}
                onClick={() => setSelectedObjectId(object.id)}
                type="button"
              >
                <span className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  {object.name}
                </span>
                <span className="text-xs uppercase tracking-[0.12em] text-[var(--nsn-warm-gray)]">
                  {object.objectType.toLowerCase()}
                </span>
              </button>
            ))}
          </div>
        </NsnCard>

        <div className="grid min-w-0 gap-5">
          {selectedObject ? (
            <NsnCard tone="aqua" className="min-w-0">
              <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-2">
                    <NsnBadge tone={statusTone(selectedObject.status)}>
                      {selectedObject.status.toLowerCase()}
                    </NsnBadge>
                    <NsnBadge tone="source">
                      {selectedObject.objectType.toLowerCase()}
                    </NsnBadge>
                  </div>
                  <h3 className="nsn-display mt-3 break-words text-3xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                    {selectedObject.name}
                  </h3>
                  <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                    {selectedObject.description}
                  </p>
                </div>
                <Link
                  className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)]"
                  href={getKnowledgeTopicRoute(selectedObject.id)}
                >
                  Open Topic Page
                </Link>
              </div>
            </NsnCard>
          ) : null}

          <NsnCard className="min-w-0">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="nsn-display text-xl text-[var(--nsn-navy)]">
                Nearby relationships
              </h3>
              <button
                aria-pressed={showAllRelationships}
                className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                onClick={() => setShowAllRelationships((current) => !current)}
                type="button"
              >
                {showAllRelationships ? "Show selected only" : "Show broader list"}
              </button>
            </div>

            {relationshipList.length > 0 ? (
              <ol className="mt-4 grid min-w-0 gap-3" aria-label="Relationship list">
                {relationshipList.map((relationship) => {
                  const isOrganizationHistory =
                    isOrganizationHistoryRelationshipType(
                      relationship.relationshipType,
                    );
                  const relationshipLabel = formatKnowledgeRelationshipType(
                    relationship.relationshipType,
                  );
                  const locations = organizationHistoryLocationsFromEvidence(
                    relationship.evidence,
                  );

                  return (
                    <li
                      className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
                      key={relationship.id}
                    >
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
                      <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                        {relationship.explanation}
                      </p>
                      {isOrganizationHistory ? (
                        <dl className="grid min-w-0 gap-2 text-xs leading-5 text-[var(--nsn-slate)] sm:grid-cols-2">
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
                    </li>
                  );
                })}
              </ol>
            ) : (
              <NsnEmptyState
                description="Choose another topic or change the filter."
                title="No nearby relationships"
              />
            )}
          </NsnCard>
        </div>
      </div>
    </section>
  );
}
