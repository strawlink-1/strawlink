import { useState, type ReactNode } from "react";

/** Hover/focus explanation for a number: what it is and where it comes from. */
export function Tip({ children, text }: { children: ReactNode; text: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(r.left, window.innerWidth - 320), y: r.bottom + 6 });
  };
  return (
    <>
      <span
        className="tip"
        tabIndex={0}
        onMouseEnter={(e) => show(e.currentTarget)}
        onMouseLeave={() => setPos(null)}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={() => setPos(null)}
      >
        {children}
      </span>
      {pos && (
        <span className="tip-pop" role="tooltip" style={{ left: pos.x, top: pos.y }}>
          {text}
        </span>
      )}
    </>
  );
}
