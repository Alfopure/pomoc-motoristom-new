"use client";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** History controls can sit near the mobile bottom navigation; keep their choices in view. */
export function HistoryMenu({ className, summary, children }: { className: string; summary: ReactNode; children: ReactNode }) {
  const root = useRef<HTMLDetailsElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!root.current || !panel.current) return;
      const anchor = root.current.getBoundingClientRect();
      const header = document.querySelector(".dispatch-app-header")?.getBoundingClientRect();
      const topEdge = Math.max(12, header && header.top <= 0 ? header.bottom + 8 : 12);
      const bottom = window.innerHeight - (window.innerWidth < 1024 ? 76 : 12);
      const maxHeight = Math.max(64, bottom - topEdge);
      panel.current.style.maxHeight = `${maxHeight}px`;
      const rect = panel.current.getBoundingClientRect();
      const below = anchor.bottom + 5;
      const preferredTop = below + rect.height <= bottom ? below : anchor.top - rect.height - 5;
      const top = Math.max(topEdge, Math.min(preferredTop, bottom - rect.height));
      const left = Math.max(12, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 12));
      setPosition({ position: "fixed", top, left, right: "auto", maxHeight });
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      place();
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current && !root.current.contains(event.target)) root.current.open = false;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  return <details ref={root} className={className} onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => {
    if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
  }}><summary>{summary}</summary><div ref={panel} style={position}>{children}</div></details>;
}
