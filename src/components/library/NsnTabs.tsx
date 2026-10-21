"use client";

import { useId, useRef, useState, type ReactNode } from "react";

/** Presentation-only tabs: panels stay mounted so inputs and action state survive. */
export function NsnTabs({ label, tabs }: { label: string; tabs: { label: string; content: ReactNode }[] }) {
  const id = useId();
  const [active, setActive] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return <div className="nsn-tabs">
    <div className="nsn-tab-list" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => <button
        key={tab.label}
        ref={element => { buttons.current[index] = element; }}
        type="button" role="tab" id={`${id}-tab-${index}`}
        aria-selected={active === index} aria-controls={`${id}-panel-${index}`}
        tabIndex={active === index ? 0 : -1}
        onClick={() => setActive(index)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
            : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next !== null) { event.preventDefault(); setActive(next); buttons.current[next]?.focus(); }
        }}
      >{tab.label}</button>)}
    </div>
    {tabs.map((tab, index) => <div key={tab.label} className="nsn-tab-panel" role="tabpanel"
      id={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`} hidden={active !== index} tabIndex={0}
    >{tab.content}</div>)}
  </div>;
}
