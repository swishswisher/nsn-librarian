import type { ComponentPropsWithoutRef } from "react";

type NsnCardProps = ComponentPropsWithoutRef<"article"> & {
  tone?: "plain" | "aqua" | "sand";
};

const toneClasses: Record<NonNullable<NsnCardProps["tone"]>, string> = {
  plain: "bg-[var(--nsn-card)]",
  aqua: "bg-[linear-gradient(135deg,var(--nsn-soft-aqua),var(--nsn-sage-mist))]",
  sand: "bg-[linear-gradient(135deg,var(--nsn-card),var(--nsn-sand))]",
};

export function NsnCard({
  children,
  className = "",
  tone = "plain",
  ...props
}: NsnCardProps) {
  return (
    <article
      className={["nsn-card p-5", toneClasses[tone], className].join(" ")}
      {...props}
    >
      {children}
    </article>
  );
}
