"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import type { MindResult } from "@/lib/librarian-mind";

type MindPreviewButtonProps = {
  documentId: string;
  itemTitle: string;
  canObserve: boolean;
};

type ObserveResponse =
  | {
      ok: true;
      result: MindResult;
      sessionId: string;
      observerType: string;
      connectionCount: number;
      hasReviewableSuggestions: boolean;
    }
  | {
      ok: false;
      error: string;
    };

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}%`;
}

function observationModeLabel(observerType: string | null) {
  return observerType === "OPENAI"
    ? "Observed with AI assistance"
    : "Observed with basic observation mode";
}

function examinedItemHref(documentId: string) {
  return `/admin/library/documents?examined=${encodeURIComponent(documentId)}`;
}

function reviewSuggestionsHref(sessionId: string) {
  return `/admin/library/review/${encodeURIComponent(sessionId)}`;
}

function navigationChoicesFor({
  documentId,
  hasReviewableSuggestions,
  sessionId,
}: {
  documentId: string;
  hasReviewableSuggestions: boolean;
  sessionId: string | null;
}) {
  return {
    primary: hasReviewableSuggestions && sessionId
      ? {
          href: reviewSuggestionsHref(sessionId),
          label: "Review Recommendations",
        }
      : {
          href: examinedItemHref(documentId),
          label: "View Examined Items",
        },
    libraryHref: "/admin/library/documents",
  };
}

export function MindPreviewButton({
  documentId,
  itemTitle,
  canObserve,
}: MindPreviewButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MindResult | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [observerType, setObserverType] = useState<string | null>(null);
  const [connectionCount, setConnectionCount] = useState(0);
  const [hasReviewableSuggestions, setHasReviewableSuggestions] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const primaryActionRef = useRef<HTMLAnchorElement>(null);
  const choices = navigationChoicesFor({
    documentId,
    hasReviewableSuggestions,
    sessionId,
  });

  function closeDialog() {
    setIsOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (result) {
      primaryActionRef.current?.focus();
      return;
    }

    closeButtonRef.current?.focus();
  }, [isOpen, result]);

  async function observeItem() {
    if (!canObserve || isLoading) {
      return;
    }

    setIsOpen(true);
    setIsLoading(true);
    setError(null);
    setResult(null);
    setSessionId(null);
    setObserverType(null);
    setConnectionCount(0);
    setHasReviewableSuggestions(false);

    try {
      const response = await fetch("/api/library/mind/observe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ documentId }),
      });
      const payload = (await response.json()) as ObserveResponse;

      if (!payload.ok) {
        setError(payload.error);
        return;
      }

      setResult(payload.result);
      setSessionId(payload.sessionId);
      setObserverType(payload.observerType);
      setConnectionCount(payload.connectionCount);
      setHasReviewableSuggestions(payload.hasReviewableSuggestions);
    } catch {
      setError("The Librarian could not observe this item right now.");
    } finally {
      setIsLoading(false);
    }
  }

  if (!canObserve) {
    return (
      <span
        aria-disabled="true"
        className="inline-flex min-h-10 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-sand)] px-3 text-center text-sm font-semibold text-[var(--nsn-warm-gray)]"
        title="The Librarian can only examine items it has successfully read."
      >
        Read first
      </span>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="inline-flex min-h-10 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-teal-dark)] transition hover:bg-[var(--nsn-sage-mist)] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isLoading}
        onClick={observeItem}
        title="Examine this library item"
        type="button"
      >
        Examine
      </button>

      {isOpen ? (
        <div
          aria-labelledby={`mind-preview-${documentId}`}
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[rgb(31_42_68_/_0.45)] p-2 sm:p-4"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeDialog();
            }
          }}
          role="dialog"
        >
          <div className="flex max-h-[calc(100dvh-1rem)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] shadow-[0_24px_80px_rgb(31_42_68_/_0.25)] sm:max-h-[calc(100dvh-2rem)]">
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 sm:p-5">
              <div className="min-w-0 pr-2">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                  Examination Complete
                </p>
                <h2
                  className="nsn-display mt-2 break-words text-xl leading-7 text-[var(--nsn-navy)] [overflow-wrap:anywhere] sm:text-2xl"
                  id={`mind-preview-${documentId}`}
                >
                  {result
                    ? "The Librarian has finished examining these items."
                    : itemTitle}
                </h2>
              </div>
              <button
                ref={closeButtonRef}
                className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-3 text-sm font-semibold text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]"
                onClick={closeDialog}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
              <div className="grid gap-4">
                <div className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-navy)]">
                  <p>
                    The Librarian is observing patterns, not making final decisions.
                  </p>
                  <p className="font-semibold">The machine suggests. Deanne decides.</p>
                </div>

                {isLoading ? (
                  <p className="rounded-md bg-[var(--nsn-cream)] p-3 text-sm font-semibold text-[var(--nsn-slate)]">
                    The Librarian is examining this item.
                  </p>
                ) : null}

                {error ? (
                  <p className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-warm-beige)] p-3 text-sm font-semibold leading-6 text-[var(--nsn-danger)]">
                    {error}
                  </p>
                ) : null}

                {result ? (
                  <div className="grid gap-5">
                    <section className="grid gap-3 rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-card)] p-4">
                      <p className="text-lg font-semibold leading-7 text-[var(--nsn-navy)]">
                        Where would you like to go next?
                      </p>
                      <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                        {itemTitle}
                      </p>
                      <div className="grid gap-1 text-sm leading-6 text-[var(--nsn-slate)]">
                        <p>{observationModeLabel(observerType)}</p>
                        <p>
                          Confidence is a preview signal only:{" "}
                          {formatConfidence(result.overallConfidence)}
                        </p>
                        {connectionCount > 0 ? (
                          <p>
                            This item appears related to {connectionCount} other{" "}
                            {connectionCount === 1 ? "piece" : "pieces"} in your
                            library.
                          </p>
                        ) : null}
                      </div>
                    </section>

                    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                      <Link
                        ref={primaryActionRef}
                        className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] focus:outline-none focus:ring-2 focus:ring-[var(--nsn-teal)] focus:ring-offset-2"
                        href={choices.primary.href}
                      >
                        {choices.primary.label}
                      </Link>
                      <Link
                        className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] focus:outline-none focus:ring-2 focus:ring-[var(--nsn-teal)] focus:ring-offset-2"
                        href={choices.libraryHref}
                      >
                        View My Library
                      </Link>
                      <button
                        className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] focus:outline-none focus:ring-2 focus:ring-[var(--nsn-teal)] focus:ring-offset-2 sm:col-span-2"
                        onClick={closeDialog}
                        type="button"
                      >
                        Stay on Home
                      </button>
                    </div>

                    {result.warnings.length > 0 ? (
                      <section className="grid gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                        <h3 className="text-sm font-semibold text-[var(--nsn-navy)]">
                          Notes
                        </h3>
                        <ul className="grid gap-1 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
                          {result.warnings.map((warning) => (
                            <li
                              className="list-disc break-words [overflow-wrap:anywhere]"
                              key={warning}
                            >
                              {warning}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
