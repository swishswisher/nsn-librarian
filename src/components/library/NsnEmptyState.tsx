type NsnEmptyStateProps = {
  title: string;
  description: string;
};

export function NsnEmptyState({ title, description }: NsnEmptyStateProps) {
  return (
    <div className="nsn-card bg-[var(--nsn-card)] p-6 text-left">
      <h3 className="nsn-display text-xl text-[var(--nsn-navy)]">{title}</h3>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--nsn-slate)]">
        {description}
      </p>
    </div>
  );
}
