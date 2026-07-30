import type { DashboardMetric } from "@/types/library";

type LibraryDashboardCardsProps = {
  metrics: DashboardMetric[];
};

const toneClasses: Record<DashboardMetric["tone"], string> = {
  sage: "border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)]",
  sand: "border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)]",
  review: "border-[var(--nsn-warm-beige)] bg-[var(--nsn-warm-beige)]",
  aqua: "border-[var(--nsn-soft-aqua)] bg-[var(--nsn-soft-aqua)]",
};

export function LibraryDashboardCards({ metrics }: LibraryDashboardCardsProps) {
  return (
    <section aria-label="Library home metrics">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <article
            className={[
              "rounded-lg border p-5 shadow-[0_16px_36px_rgb(31_42_68_/_0.05)]",
              toneClasses[metric.tone],
            ].join(" ")}
            key={metric.label}
          >
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-teal-dark)]">
              {metric.label}
            </p>
            <p className="nsn-display mt-5 text-4xl text-[var(--nsn-navy)]">
              {metric.value}
            </p>
            <p className="mt-2 text-sm leading-6 text-[var(--nsn-slate)]">
              {metric.helper}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
