import { Component, createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LOOKS } from "../scene/looks";
import type { Look } from "../sim/stage";

/* ---------------------------------------------------------------- slots: a page fills the side panel, the strip above the map and the strip below it */

export const Slots = createContext<{ panel: HTMLElement | null; above: HTMLElement | null; below: HTMLElement | null }>({ panel: null, above: null, below: null });
export function InPanel({ children }: { children: ReactNode }) {
  const { panel } = useContext(Slots);
  return panel ? createPortal(<div className="panel-anim">{children}</div>, panel) : null;
}
export function InAbove({ children }: { children: ReactNode }) {
  const { above } = useContext(Slots);
  return above ? createPortal(children, above) : null;
}
export function InBelow({ children }: { children: ReactNode }) {
  const { below } = useContext(Slots);
  return below ? createPortal(children, below) : null;
}

/** If a page fails, say so in its panel and keep the rest of the app alive. */
export class Guard extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e) }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <InPanel>
        <h1>This page could not be shown.</h1>
        <p className="note warn">{this.state.error}</p>
        <button type="button" className="btn ghost" onClick={() => location.reload()}>Reload</button>
      </InPanel>
    );
  }
}

/* ---------------------------------------------------------------- icons (24px, stroke) */

const PATHS: Record<string, string> = {
  play: "M8 5v14l11-7z",
  pause: "M7 5h4v14H7zM13 5h4v14h-4z",
  restart: "M4 12a8 8 0 1 0 2.6-5.9M4 4v5h5",
  phone: "M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  x: "M6 6l12 12M18 6L6 18",
  home: "M4 11l8-7 8 7M6 10v9h12v-9",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  check: "M5 13l4 4L19 7",
};
export function Icon({ name, size = 18, fill = false }: { name: string; size?: number; fill?: boolean }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

/* ---------------------------------------------------------------- controls */

/** One input the planner listens to. */
export function Slider({ label, hint, value, min, max, step = 1, onChange, show, mark }: {
  label: string; hint?: ReactNode; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; show?: ReactNode; mark?: { at: number; label: string };
}) {
  const id = useId();
  const pct = ((value - min) / (max - min || 1)) * 100;
  return (
    <div className="slider">
      <div className="slider-top"><label htmlFor={id}>{label}</label><output htmlFor={id}>{show ?? value}</output></div>
      <div className="slider-track">
        <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} style={{ "--fill": `${pct}%` } as React.CSSProperties} />
        {mark && <span className="slider-mark" style={{ left: `${((mark.at - min) / (max - min || 1)) * 100}%` }} title={mark.label} />}
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function Seg<T extends string | number>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { v: T; label: ReactNode }[]; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => <button key={String(o.v)} type="button" aria-pressed={value === o.v} onClick={() => onChange(o.v)}>{o.label}</button>)}
    </div>
  );
}

export function Group({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="group">
      <h2>{title}{aside && <small>{aside}</small>}</h2>
      {children}
    </section>
  );
}

/** Hover or focus explanation for a number: what it is and where it comes from. */
export function Tip({ children, text }: { children: ReactNode; text: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(r.left, window.innerWidth - 300)), y: r.bottom + 6 });
  };
  return (
    <>
      <span className="tip" tabIndex={0} onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={() => setPos(null)} onFocus={(e) => show(e.currentTarget)} onBlur={() => setPos(null)}>
        {children}
      </span>
      {pos && createPortal(<span className="tip-pop" role="tooltip" style={{ left: pos.x, top: pos.y }}>{text}</span>, document.body)}
    </>
  );
}

/** Numbers glide to their new value when the plan changes. */
export function Count({ value, digits = 0 }: { value: number; digits?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const a = from.current, t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / 500);
      const v = a + (value - a) * (1 - Math.pow(1 - u, 3));
      from.current = v;
      setShown(v);
      if (u < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown.toFixed(digits)}</>;
}

export function Stat({ k, v, unit, tone, tip }: { k: ReactNode; v: ReactNode; unit?: string; tone?: "warn" | "risk" | "ok" | "wet"; tip?: string }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <span className="v">{v}{unit && <small>{unit}</small>}</span>
      <span className="k">{tip ? <Tip text={tip}>{k}</Tip> : k}</span>
    </div>
  );
}

/** What the field colours mean, with how many fields have each. */
export function Legend({ items }: { items: { look: Look; label?: string; n?: number }[] }) {
  return (
    <ul className="legend">
      {items.map((l) => (
        <li key={l.look + (l.label ?? "")} className={l.n === 0 ? "none" : ""}>
          <i className={LOOKS[l.look].halo && l.look !== "risk" ? "ring" : ""} style={{ background: LOOKS[l.look].color, borderColor: LOOKS[l.look].halo ?? "transparent" }} />
          <Tip text={LOOKS[l.look].hint}>{l.label ?? LOOKS[l.look].label}</Tip>
          {l.n !== undefined && <b>{l.n}</b>}
        </li>
      ))}
    </ul>
  );
}
