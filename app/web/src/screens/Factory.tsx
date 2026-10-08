import { useState } from "react";
import { fmtDate } from "../api";
import { SeasonClock } from "../components/SeasonClock";
import { Tip } from "../components/Tip";
import { useApp, useFetch } from "../state";

type Plant = {
  plant_id: string; name: string; weekly_capacity_t: number; depot_capacity_t: number; fill_t: number; fields_routed: number;
  weeks: { week_start: string; tonnes_p10: number; tonnes_p50: number; tonnes_p90: number }[];
  depot_projection: { date: string; fill_t: number }[]; projected_full_on: string | null; alert: boolean;
};

export function Factory() {
  const { date, version } = useApp();
  const { data, error } = useFetch<{ plants: Plant[]; method: string }>(date ? `/plants/supply?weeks=4&date=${date}` : null, [version]);
  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
      <SeasonClock />
      <div className="page">
        <h1>Straw arriving at each plant</h1>
        <p className="lede">
          Weekly tonnes from fields routed to bale, with the likely range. Depot bars project the next 7 days of fill.{" "}
          <span className="synthetic-tag">synthetic plants</span>
        </p>
        {error && <div className="alert">Supply view unavailable: {error}</div>}
        <div className="cards">
          {data?.plants.map((p) => <PlantCard key={p.plant_id} p={p} />)}
        </div>
        {data && <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>Method: {data.method}</p>}
      </div>
    </div>
  );
}

function PlantCard({ p }: { p: Plant }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(p.weekly_capacity_t, ...p.weeks.map((w) => w.tonnes_p90), 1);
  const W = 300, H = 140, pad = 26, bw = (W - pad) / p.weeks.length;
  const y = (t: number) => H - 18 - (t / max) * (H - 30);
  const last = p.depot_projection[p.depot_projection.length - 1]?.fill_t ?? p.fill_t;
  return (
    <article className="card">
      <h2>{p.name}</h2>
      <div className="muted" style={{ fontSize: 13 }}>
        {p.plant_id} · {p.fields_routed} fields routed ·{" "}
        <Tip text="Plant use per week (config/synthetic.yaml). The dashed line on the chart.">uses {p.weekly_capacity_t} t/week</Tip>
      </div>
      {p.alert && (
        <div className="alert" style={{ marginTop: 10 }} role="status">
          Depot projected full on {fmtDate(p.projected_full_on)} — ask the planner to hold bale pickups or reroute to another plant.
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", marginTop: 10 }} role="img"
        aria-label={`Weekly expected tonnes for ${p.name}`}>
        <line x1={pad} x2={W} y1={y(p.weekly_capacity_t)} y2={y(p.weekly_capacity_t)} stroke="var(--ink-2)" strokeDasharray="4 3" />
        <text x={W} y={y(p.weekly_capacity_t) - 4} textAnchor="end" fontSize="10" fill="var(--muted)" fontFamily="var(--mono)">plant use</text>
        {p.weeks.map((w, i) => {
          const x = pad + i * bw + 6;
          const ww = bw - 12;
          return (
            <g key={w.week_start} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x - 4} y={0} width={ww + 8} height={H} fill="transparent" />
              <rect x={x} y={y(w.tonnes_p90)} width={ww} height={Math.max(0, y(w.tonnes_p10) - y(w.tonnes_p90))} rx="4" fill="var(--bale)" opacity="0.25" />
              <rect x={x + ww * 0.3} y={y(w.tonnes_p50)} width={ww * 0.4} height={Math.max(2, H - 18 - y(w.tonnes_p50))} rx="4" fill="var(--bale)" opacity={hover === null || hover === i ? 1 : 0.5} />
              <text x={x + ww / 2} y={H - 4} textAnchor="middle" fontSize="10" fill="var(--muted)" fontFamily="var(--mono)">{fmtDate(w.week_start)}</text>
            </g>
          );
        })}
        <line x1={pad} x2={W} y1={H - 18} y2={H - 18} stroke="var(--line)" />
      </svg>
      <div style={{ fontSize: 13, minHeight: 20 }}>
        {hover !== null ? (
          <>Week of {fmtDate(p.weeks[hover].week_start)}: <b className="num">{p.weeks[hover].tonnes_p50.toFixed(0)} t</b> likely, range <span className="num">{p.weeks[hover].tonnes_p10.toFixed(0)}–{p.weeks[hover].tonnes_p90.toFixed(0)} t</span></>
        ) : (
          <span className="muted">Solid bar: likely (P50). Pale band: P10–P90 range. Hover a week for numbers.</span>
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span>Depot</span>
          <span className="num">{p.fill_t.toFixed(0)} → {last.toFixed(0)} / {p.depot_capacity_t} t in 7 days</span>
        </div>
        <div style={{ height: 12, background: "var(--line-2)", borderRadius: 6, position: "relative", overflow: "hidden", marginTop: 4 }}>
          <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, (p.fill_t / p.depot_capacity_t) * 100)}%`, background: "var(--ink-2)" }} />
          <div style={{ position: "absolute", top: 0, bottom: 0, left: `${Math.min(100, (p.fill_t / p.depot_capacity_t) * 100)}%`, width: `${Math.max(0, Math.min(100, (last / p.depot_capacity_t) * 100) - (p.fill_t / p.depot_capacity_t) * 100)}%`, background: last >= p.depot_capacity_t ? "var(--risk)" : "var(--bale)", opacity: 0.7 }} />
        </div>
      </div>
      <details style={{ marginTop: 10, fontSize: 13 }}>
        <summary>Table view</summary>
        <table className="data">
          <thead><tr><th>Week</th><th>P10</th><th>P50</th><th>P90</th></tr></thead>
          <tbody>{p.weeks.map((w) => <tr key={w.week_start}><td>{w.week_start}</td><td>{w.tonnes_p10}</td><td>{w.tonnes_p50}</td><td>{w.tonnes_p90}</td></tr>)}</tbody>
        </table>
      </details>
    </article>
  );
}
