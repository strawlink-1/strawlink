import { useRef } from "react";
import { clock, useClockSample } from "./clock";
import { hhmm } from "./geo";
import type { World } from "./model";

const TYPE_LABEL = { baler_set: "Baler", seeder: "Super Seeder", truck: "Tractor-trolley" } as const;

/** Gantt of every machine's real plan legs. Drag or click anywhere to scrub the film. */
export function Timeline({ world, selected, onPickMachine }: { world: World; selected: string | null; onPickMachine: (id: string) => void }) {
  const c = useClockSample(12);
  const box = useRef<HTMLDivElement>(null);
  const t0 = world.dayStart, t1 = world.dayEnd, span = t1 - t0;
  const x = (t: number) => `${((Math.max(t0, Math.min(t1, t)) - t0) / span) * 100}%`;
  const w = (a: number, b: number) => `${((Math.min(t1, b) - Math.max(t0, a)) / span) * 100}%`;
  const scrub = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    clock.seek(t0 + ((clientX - r.left) / r.width) * span);
  };
  const machines = world.machines.filter((m) => m.stops.length);
  const hours = [];
  for (let h = Math.ceil(t0 / 60); h * 60 <= t1; h++) hours.push(h * 60);

  return (
    <div className="tl" aria-label="Plan timeline">
      <div className="tl-names">
        <div className="tl-axis-pad" />
        {machines.map((m) => (
          <button key={m.id} className={`tl-name${selected === m.id ? " sel" : ""}`} onClick={() => onPickMachine(m.id)} style={{ ["--mc" as string]: m.color }}>
            <i />{m.id}<small>{TYPE_LABEL[m.type]}</small>
          </button>
        ))}
        {!machines.length && <div className="tl-empty">No machine has stops in this plan.</div>}
      </div>
      <div
        className="tl-track"
        ref={box}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); scrub(e.clientX); }}
        onPointerMove={(e) => { if (e.buttons) scrub(e.clientX); }}
        role="slider"
        aria-label="Simulation time"
        aria-valuemin={t0}
        aria-valuemax={t1}
        aria-valuenow={Math.round(c.t)}
        aria-valuetext={hhmm(c.t)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") clock.seek(c.t + 10);
          if (e.key === "ArrowLeft") clock.seek(c.t - 10);
        }}
      >
        <div className="tl-axis">
          {hours.map((h) => <span key={h} style={{ left: x(h) }}>{hhmm(h)}</span>)}
        </div>
        {machines.map((m) => (
          <div key={m.id} className={`tl-lane${selected === m.id ? " sel" : ""}`}>
            {m.legs.map((l, i) => {
              if (l.kind === "idle" || l.t1 < t0 || l.t0 > t1) return null;
              const cls = l.kind === "work" ? "work" : l.kind === "drive" ? "drive" : "load";
              const title = l.kind === "work" ? `${l.fieldId} · ${l.method === "bale" ? "baling" : "sowing"} ${hhmm(l.t0)}–${hhmm(l.t1)}`
                : l.kind === "load" ? `load ${l.fieldId} · ${l.tonnes.toFixed(1)} t` : l.kind === "unload" ? `unload ${l.plantId}` : `drive ${hhmm(l.t0)}–${hhmm(l.t1)}`;
              return (
                <span key={i} className={`tl-blk ${cls}`} style={{ left: x(l.t0), width: w(l.t0, l.t1), ["--mc" as string]: m.color }} title={title}>
                  {l.kind === "work" && <em>{l.fieldId}</em>}
                </span>
              );
            })}
          </div>
        ))}
        <div className="tl-head" style={{ left: x(c.t) }}><b>{hhmm(c.t)}</b></div>
      </div>
    </div>
  );
}
