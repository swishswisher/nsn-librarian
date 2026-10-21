"use client";
import { useEffect, useRef, type ReactNode } from "react";

export function MobileLibraryMenu({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => {
      if (desktop.matches) dialog.current?.close();
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  return <div className="nsn-mobile-menu">
    <button ref={trigger} type="button" className="nsn-menu-trigger" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>Menu</button>
    <dialog ref={dialog} className="nsn-menu-dialog" aria-label="Workspace navigation" onClose={() => trigger.current?.focus()} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="nsn-menu-panel">
        <div className="nsn-menu-heading"><span className="nsn-display">Your workspace</span><button type="button" className="nsn-menu-trigger" onClick={() => dialog.current?.close()}>Close</button></div>
        <div onClick={event => { if ((event.target as HTMLElement).closest("a")) dialog.current?.close(); }}>{children}</div>
      </div>
    </dialog>
  </div>;
}
