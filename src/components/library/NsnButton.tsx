import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type NsnButtonVariant = "primary" | "secondary" | "accent";

type NsnButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: NsnButtonVariant;
};

const variantClasses: Record<NsnButtonVariant, string> = {
  primary:
    "border-[var(--nsn-teal)] bg-[var(--nsn-teal)] text-[var(--nsn-white)] hover:bg-[var(--nsn-teal-dark)]",
  secondary:
    "border-[var(--nsn-border)] bg-[var(--nsn-card)] text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]",
  accent:
    "border-[var(--nsn-gold)] bg-[var(--nsn-warm-beige)] text-[var(--nsn-navy)] hover:bg-[var(--nsn-sand)]",
};

export const NsnButton = forwardRef<HTMLButtonElement, NsnButtonProps>(function NsnButton(
  {
    children,
    className = "",
    variant = "secondary",
    ...props
  },
  ref,
) {
  return (
    <button
      className={[
        "inline-flex min-h-11 max-w-full items-center justify-center rounded-md border px-4 text-center text-sm font-semibold whitespace-normal transition [overflow-wrap:anywhere] disabled:cursor-not-allowed disabled:opacity-60",
        variantClasses[variant],
        className,
      ].join(" ")}
      ref={ref}
      {...props}
    >
      {children}
    </button>
  );
});
