import type { ReactNode } from "react";

type NsnTableShellProps = {
  children: ReactNode;
  className?: string;
};

export function NsnTableShell({ children, className = "" }: NsnTableShellProps) {
  return (
    <div className={["nsn-table-shell", className].join(" ")}>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}
