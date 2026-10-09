"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import type { LibraryAnswer } from "@/lib/library/qa/types";

const answerLabels: Record<LibraryAnswer["state"], string> = {
  ANSWERED_FROM_SOURCES: "Answered from sources",
  PARTIALLY_ANSWERED: "Partially answered",
  CONFLICTING_SOURCES: "Conflicting sources",
  INSUFFICIENT_EVIDENCE: "Insufficient evidence",
  NO_AUTHORIZED_MATCH: "No authorized matching information",
  SEARCH_INDEX_INCOMPLETE: "Search index incomplete",
  MODEL_UNAVAILABLE: "Answering temporarily unavailable",
  AMBIGUOUS_ENTITY: "More detail needed",
  SOURCE_CHANGED: "Sources changed",
};

export function AskLibrarianPanel() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<LibraryAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (asking || question.trim().length < 3) return;
    setAsking(true);
    setError(null);
    setAnswer(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch("/api/library/ask", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
        cache: "no-store", signal: controller.signal,
      });
      const payload: { ok?: boolean; result?: LibraryAnswer; error?: string } = await response.json();
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error ?? "The Librarian could not answer right now.");
      }
      setAnswer(payload.result);
    } catch {
      setError("The Librarian could not answer right now. Library search is still available.");
    } finally {
      clearTimeout(timeout);
      setAsking(false);
    }
  }

  return (
    <section aria-labelledby="ask-librarian-heading" className="min-w-0 border-y border-[var(--nsn-border)] py-5">
      <h3 className="text-base font-semibold text-[var(--nsn-navy)]" id="ask-librarian-heading">Ask the Librarian</h3>
      <form className="mt-3 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end" onSubmit={submit}>
        <div className="min-w-0 flex-1">
          <label className="block text-sm font-medium text-[var(--nsn-navy)]" htmlFor="library-question">Question</label>
          <textarea className="mt-1 min-h-20 w-full min-w-0 resize-y rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-white)] p-3 text-sm text-[var(--nsn-navy)]"
            id="library-question" maxLength={500} onChange={(event) => setQuestion(event.target.value)}
            placeholder="What do we have about this subject?" value={question} />
        </div>
        <button className="min-h-11 shrink-0 rounded-md bg-[var(--nsn-teal)] px-5 text-sm font-semibold text-white disabled:opacity-50"
          disabled={asking || question.trim().length < 3} type="submit">{asking ? "Checking sources..." : "Ask"}</button>
      </form>
      <div aria-live="polite" className="mt-3 min-w-0">
        {error ? <p className="text-sm text-[var(--nsn-danger)]">{error}</p> : null}
        {answer ? (
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-[var(--nsn-teal)]">{answerLabels[answer.state]}</p>
            <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">{answer.answer}</p>
            {answer.notice ? <p className="mt-2 text-sm text-[var(--nsn-slate)]">{answer.notice}</p> : null}
            {answer.usage ? <details className="mt-2 text-xs text-[var(--nsn-slate)]">
              <summary className="cursor-pointer">AI answer usage</summary>
              <p className="mt-1">{answer.usage.requests} answer request; {answer.usage.httpAttempts} HTTP attempts. {answer.usage.inputTokens === null || answer.usage.outputTokens === null
                ? "Provider token totals unavailable." : `Provider-reported tokens: ${answer.usage.inputTokens} input, ${answer.usage.outputTokens} output.`} Cost estimate unavailable.</p>
            </details> : null}
            {answer.claims.length ? (
              <ol className="mt-4 grid min-w-0 gap-3" aria-label="Supported statements">
                {answer.claims.map((claim, index) => (
                  <li className="min-w-0 border-l-2 border-[var(--nsn-teal)] pl-3" key={`${index}-${claim.text}`}>
                    <p className="break-words text-sm text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                      {claim.kind === "INFERENCE" ? "Inference: " : claim.kind === "CONFLICT" ? "Conflict: " : ""}{claim.text}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--nsn-teal-dark)]">
                      {claim.sourceIds.map((id) => {
                        const position = answer.sources.findIndex((source) => source.id === id);
                        return position >= 0 ? <a className="underline" href={`#answer-source-${position + 1}`}
                          key={id}>Source {position + 1}</a> : null;
                      })}
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
            {answer.sources.length ? (
              <div className="mt-5 min-w-0">
                <h4 className="text-sm font-semibold text-[var(--nsn-navy)]">Sources</h4>
                <ol className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2">
                  {answer.sources.map((source, index) => (
                    <li className="min-w-0 border-t border-[var(--nsn-border)] pt-2" id={`answer-source-${index + 1}`} key={source.id}>
                      <p className="break-words text-sm font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                        {index + 1}. {source.title}
                      </p>
                      <p className="break-words text-xs text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                        {source.rootName}{source.relativePath ? ` / ${source.relativePath}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-[var(--nsn-slate)]">
                        {source.sourceType === "APPROVED_MEMORY" ? "Human-approved Memory" :
                          source.sourceType === "FILE_METADATA" ? "File details only" : "Verified source excerpt"}
                        {` | ${source.trustState} | ${source.timeState}`}
                        {source.sourceRange ? ` | Characters ${source.sourceRange.start}-${source.sourceRange.end}` : ""}
                      </p>
                      <details className="mt-2 text-sm text-[var(--nsn-navy)]">
                        <summary className="cursor-pointer font-medium">Supporting material</summary>
                        <p className="mt-2 break-words [overflow-wrap:anywhere]">{source.text}</p>
                      </details>
                      <Link className="mt-2 inline-flex min-h-9 items-center text-sm font-semibold text-[var(--nsn-teal-dark)] underline"
                        href={source.href}>{source.sourceType === "APPROVED_MEMORY" ? "Open Memory" : "Open item"}</Link>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
