"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { NsnButton } from "@/components/library/NsnButton";
import type { BridgeOrganizationPlanGenerationResponse } from "@/lib/bridge/types";
import { getOrganizationPlanRoute } from "@/lib/library/routes";

type OrganizationPlanGenerateButtonProps = {
  scanSessionId: string;
  label?: string;
  className?: string;
};

export function OrganizationPlanGenerateButton({
  className = "",
  label = "Generate Organization Plan",
  scanSessionId,
}: OrganizationPlanGenerateButtonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  async function generatePlan() {
    if (isGenerating) {
      return;
    }

    setError(null);
    setIsGenerating(true);

    try {
      const response = await fetch(
        `/api/bridge/scan-sessions/${encodeURIComponent(
          scanSessionId,
        )}/organization-plan`,
        {
          method: "POST",
        },
      );
      const payload =
        (await response.json()) as BridgeOrganizationPlanGenerationResponse;

      if (!payload.ok) {
        setError(payload.error);
        return;
      }

      router.push(getOrganizationPlanRoute(scanSessionId));
      router.refresh();
    } catch {
      setError("The organization plan could not be generated right now.");
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <div className={["grid min-w-0 gap-2", className].join(" ")}>
      <NsnButton
        aria-busy={isGenerating}
        disabled={isGenerating}
        onClick={generatePlan}
        type="button"
        variant="primary"
      >
        {isGenerating ? "Generating Plan..." : label}
      </NsnButton>
      {error ? (
        <p
          className="break-words rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)] [overflow-wrap:anywhere]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
