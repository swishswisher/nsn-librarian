"use client";

import { useEffect, useMemo, useState } from "react";

import { NsnButton } from "@/components/library/NsnButton";

type PairingCode = {
  code: string;
  expiresAt: string;
  id: string;
};

type PairingResponse =
  | {
      ok: true;
      pairing: PairingCode;
    }
  | {
      error: string;
      ok: false;
    };

export function BridgePairingPanel() {
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [message, setMessage] = useState(
    "Generate a short-lived code, then enter it inside NSN Bridge on this Mac.",
  );
  const [isLoading, setIsLoading] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!pairing) {
      return;
    }

    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(interval);
  }, [pairing]);

  const secondsRemaining = pairing
    ? Math.max(
        0,
        Math.floor((new Date(pairing.expiresAt).getTime() - nowMs) / 1000),
      )
    : 0;

  const expirationCopy = useMemo(() => {
    if (!pairing) {
      return null;
    }

    if (secondsRemaining <= 0) {
      return "This code has expired. Generate a new one before pairing.";
    }

    const minutes = Math.floor(secondsRemaining / 60);
    const seconds = secondsRemaining % 60;

    return `Expires in ${minutes}:${seconds.toString().padStart(2, "0")}.`;
  }, [pairing, secondsRemaining]);

  async function createPairingCode() {
    setIsLoading(true);
    setMessage("Creating a pairing code...");

    try {
      const response = await fetch("/api/bridge/cloud/pairing-codes", {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | PairingResponse
        | null;

      if (!response.ok || !payload?.ok) {
        setMessage(
          payload?.ok === false
            ? payload.error
            : "The Librarian could not create a pairing code right now.",
        );
        return;
      }

      setPairing(payload.pairing);
      setNowMs(Date.now());
      setMessage("Enter this code inside NSN Bridge.");
    } catch {
      setMessage("The Librarian could not create a pairing code right now.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-5">
      <div
        aria-live="polite"
        className="grid min-h-32 min-w-0 place-items-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-5 text-center"
      >
        {pairing ? (
          <div className="grid min-w-0 gap-2">
            <p className="break-words font-mono text-4xl font-bold tracking-[0.16em] text-[var(--nsn-navy)] [overflow-wrap:anywhere] sm:text-5xl">
              {pairing.code}
            </p>
            {expirationCopy ? (
              <p className="text-sm leading-6 text-[var(--nsn-slate)]">
                {expirationCopy}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="max-w-xl break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            Pairing codes are short-lived and can be used only once.
          </p>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap">
        <NsnButton
          disabled={isLoading}
          onClick={createPairingCode}
          type="button"
          variant="primary"
        >
          {pairing ? "Generate New Code" : "Generate Pairing Code"}
        </NsnButton>
        <a
          className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] sm:w-fit"
          href="/download/bridge"
        >
          Download Bridge
        </a>
      </div>

      <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
        {message}
      </p>
    </div>
  );
}
