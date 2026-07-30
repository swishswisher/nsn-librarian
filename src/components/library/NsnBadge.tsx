import type { ReactNode } from "react";

export type NsnBadgeTone =
  | "pending"
  | "review"
  | "approved"
  | "migration"
  | "unknown"
  | "source"
  | "gold";

type NsnBadgeProps = {
  children: ReactNode;
  tone?: NsnBadgeTone;
  className?: string;
};

const toneClasses: Record<NsnBadgeTone, string> = {
  pending:
    "border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] text-[var(--nsn-warning)]",
  review:
    "border-[var(--nsn-warm-beige)] bg-[var(--nsn-warm-beige)] text-[var(--nsn-danger)]",
  approved:
    "border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] text-[var(--nsn-teal-dark)]",
  migration:
    "border-[var(--nsn-soft-aqua)] bg-[var(--nsn-soft-aqua)] text-[var(--nsn-teal-dark)]",
  unknown:
    "border-[var(--nsn-border)] bg-[var(--nsn-card)] text-[var(--nsn-warm-gray)]",
  source:
    "border-[var(--nsn-border)] bg-[var(--nsn-cream)] text-[var(--nsn-slate)]",
  gold:
    "border-[var(--nsn-gold)] bg-[var(--nsn-warm-beige)] text-[var(--nsn-navy)]",
};

export function NsnBadge({
  children,
  tone = "unknown",
  className = "",
}: NsnBadgeProps) {
  return (
    <span
      className={[
        "inline-flex w-fit max-w-full items-center whitespace-normal rounded-md border px-2.5 py-1 text-left text-xs font-semibold uppercase break-words [overflow-wrap:anywhere]",
        toneClasses[tone],
        className,
      ].join(" ")}
    >
      {children}
    </span>
  );
}
