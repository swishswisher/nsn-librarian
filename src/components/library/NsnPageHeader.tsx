import type { ReactNode } from "react";

type NsnPageHeaderProps = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  description?: string;
  children?: ReactNode;
};

export function NsnPageHeader({
  eyebrow,
  title,
  subtitle,
  description,
  children,
}: NsnPageHeaderProps) {
  return (
    <header className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
      <div className="max-w-3xl">
        {eyebrow ? (
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--nsn-teal)]">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="nsn-display mt-2 text-4xl text-[var(--nsn-navy)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-2 text-base italic text-[var(--nsn-teal)]">
            {subtitle}
          </p>
        ) : null}
        {description ? (
          <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--nsn-slate)]">
            {description}
          </p>
        ) : null}
      </div>
      {children ? <div className="w-full sm:w-auto lg:shrink-0">{children}</div> : null}
    </header>
  );
}
