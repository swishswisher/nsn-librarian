import type { ReactNode } from "react";
import Link from "next/link";

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
    <header className="nsn-page-heading flex flex-col gap-4">
      <div className="max-w-3xl">
        {eyebrow ? (
          <nav aria-label="Breadcrumb" className="nsn-breadcrumb"><Link href="/admin/library">Home</Link><span aria-hidden="true">/</span><span>{eyebrow}</span></nav>
        ) : null}
        <h1 className="nsn-display mt-5 text-[28px] sm:text-[32px] text-[var(--nsn-navy)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-2 text-base italic text-[var(--nsn-teal)]">
            {subtitle}
          </p>
        ) : null}
        {description ? (
          <p className="mt-2 max-w-3xl text-base leading-7 text-[var(--nsn-slate)]">
            {description}
          </p>
        ) : null}
      </div>
      {children ? <div className="w-full">{children}</div> : null}
    </header>
  );
}
