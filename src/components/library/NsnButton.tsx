import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type NsnButtonVariant = "primary" | "secondary" | "accent" | "quiet";

type NsnButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: NsnButtonVariant;
};

const variantClasses: Record<NsnButtonVariant, string> = {
  primary:
    "border-[var(--nsn-teal)] bg-[var(--nsn-teal)] text-[var(--nsn-white)] hover:bg-[var(--nsn-teal-dark)]",
  secondary:
    "border-[var(--nsn-border)] bg-[var(--nsn-card)] text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]",
  quiet: "border-transparent bg-transparent text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]",
  accent:
    "border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] text-[var(--nsn-teal-dark)] hover:bg-[var(--nsn-soft-aqua)]",
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
        "inline-flex min-h-11 max-w-full items-center justify-center rounded-lg border px-4 py-3 text-center text-sm font-semibold whitespace-normal transition [overflow-wrap:anywhere] disabled:cursor-not-allowed disabled:opacity-60",
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
