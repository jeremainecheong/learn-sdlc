"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import "./ScrollRegion.css";

/** Native scrolling remains available; controls make offscreen evidence discoverable. */
export function ScrollRegion({
  children,
  label,
  hint,
  className = "",
}: {
  children: ReactNode;
  label: string;
  hint: string;
  className?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const id = useId();
  const [edges, setEdges] = useState({ overflow: false, start: true, end: true });

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const remaining = element.scrollWidth - element.clientWidth;
      const next = {
        overflow: remaining > 2,
        start: element.scrollLeft <= 2,
        end: element.scrollLeft >= remaining - 2,
      };
      setEdges(previous => previous.overflow === next.overflow && previous.start === next.start && previous.end === next.end ? previous : next);
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      element.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [children]);

  const move = (direction: number) => {
    const element = viewport.current;
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(120, element.clientWidth * 0.8),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  return (
    <div className="experience-scroll-region">
      {edges.overflow && (
        <div className="experience-scroll-controls">
          <span id={`${id}-hint`}>{hint}</span>
          <div>
            <button type="button" aria-label={`Scroll ${label} left`} aria-controls={id} disabled={edges.start} onClick={() => move(-1)}>
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <button type="button" aria-label={`Scroll ${label} right`} aria-controls={id} disabled={edges.end} onClick={() => move(1)}>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
      <div
        id={id}
        ref={viewport}
        className={`experience-scroll-viewport ${className}`}
        role="region"
        aria-label={label}
        aria-describedby={edges.overflow ? `${id}-hint` : undefined}
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}
