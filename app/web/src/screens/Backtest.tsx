import { useEffect, useMemo, useState } from "react";
import { fmtDate, type FC } from "../api";
import { FieldMap } from "../components/FieldMap";
import { Tip } from "../components/Tip";
import { useFetch } from "../state";

type Row = { fleet_scale: number; policy: "strawlink" | "baseline"; reach_rate: number; burned_fields_total: number; burned_fields_reached: number; tonnes_cleared_in_time: number; window_coverage: number | null; village_volume_mape: number | null };
type Replay = { dates: string[]; cleared: Record<string, string>; burned: Record<string, string>; harvest: Record<string, string> };

const COLORS = { strawlink: "var(--seed)", baseline: "var(--forecast)" };

export function Backtest() {
  const { data, error } = useFetch<{ results: Row[]; caveats: string[]; sensitivity: Row[] | null }>("/backtest");
  const fields = useFetch<FC>("/fields");
  const [scale, setScale] = useState(1.0);
  const [policy, setPolicy] = useState<"strawlink" | "baseline">("strawlink");
  const replay = useFetch<Replay>(`/backtest/replay?policy=${policy}&scale=${scale}`, [policy, scale]);
  const [day, setDay] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing || !replay.data) return;
    const t = setInterval(() => setDay((d) => (d + 1 >= replay.data!.dates.length ? (setPlaying(false), d) : d + 1)), 160);
    return () => clearInterval(t);
  }, [playing, replay.data]);

  const at = replay.data?.dates[day];
  const fc = useMemo<FC | null>(() => {
    if (!fields.data || !replay.data || !at) return fields.data;
    const r = replay.data;
    return {
      ...fields.data,
      features: fields.data.features.map((f) => {
        const id = f.properties.field_id;
        const status = r.cleared[id] && r.cleared[id] <= at ? "cleared" : r.burned[id] && r.burned[id] <= at ? "at_risk" : r.harvest[id] && r.harvest[id] <= at ? "ready" : "forecast";
        return { ...f, properties: { ...f.properties, status } };
      }),
    };
  }, [fields.data, replay.data, at]);
  const tally = useMemo(() => {
    const c = { cleared: 0, burned: 0 };
    for (const f of fc?.features ?? []) {
      if (f.properties.status === "cleared") c.cleared++;
      if (f.properties.status === "at_risk") c.burned++;
    }
    return c;
  }, [fc]);

  const rows = data?.results ?? [];
  const scales = [0.75, 1.0, 1.25];
  const by = (p: string, s: number) => rows.find((r) => r.policy === p && r.fleet_scale === s);
  const W = 520, H = 220, pad = 34;
  const y = (v: number) => H - 24 - (v / 0.6) * (H - 40);

  return (
    <div className="page">
      <h1>Would it have helped in 2025?</h1>
      <p className="lede">
        A day-by-day replay of the 2025 season (Oct 1 – Nov 30) on 200 parcels. Both policies get the same farmer bookings; StrawLink also
        uses satellite forecasts, rain and the fair queue. A burned field counts as reached if it was cleared before it burned.
      </p>
      {error && <div className="alert">Backtest not published yet: {error}</div>}
      {rows.length > 0 && (
        <div className="cards">
          <article className="card">
            <h2>Burned fields reached</h2>
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Share of fields that burned in 2025 that each policy would have cleared first, by fleet size.</p>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Reach rate by fleet size and policy">
              {[0, 0.2, 0.4, 0.6].map((g) => (
                <g key={g}>
                  <line x1={pad} x2={W} y1={y(g)} y2={y(g)} stroke="var(--line-2)" />
                  <text x={pad - 6} y={y(g) + 4} textAnchor="end" fontSize="11" fill="var(--muted)" fontFamily="var(--mono)">{g * 100}%</text>
                </g>
              ))}
              {scales.map((s, i) => {
                const gx = pad + 20 + i * ((W - pad - 20) / 3);
                return (
                  <g key={s}>
                    {(["strawlink", "baseline"] as const).map((p, j) => {
                      const r = by(p, s);
                      if (!r) return null;
                      const x = gx + j * 46;
                      return (
                        <g key={p}>
                          <rect x={x} y={y(r.reach_rate)} width={42} height={H - 24 - y(r.reach_rate)} rx="4" fill={COLORS[p]} />
                          <text x={x + 21} y={y(r.reach_rate) - 5} textAnchor="middle" fontSize="12" fill="var(--ink)" fontFamily="var(--mono)">{(r.reach_rate * 100).toFixed(1)}%</text>
                        </g>
                      );
                    })}
                    <text x={gx + 44} y={H - 6} textAnchor="middle" fontSize="12" fill="var(--ink-2)">{s}× fleet</text>
                  </g>
                );
              })}
            </svg>
            <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
              <span><i style={{ display: "inline-block", width: 12, height: 12, background: COLORS.strawlink, borderRadius: 3, marginRight: 6 }} />StrawLink</span>
              <span><i style={{ display: "inline-block", width: 12, height: 12, background: COLORS.baseline, borderRadius: 3, marginRight: 6 }} />First-come baseline</span>
            </div>
            <details style={{ marginTop: 10, fontSize: 13 }}>
              <summary>Table view</summary>
              <table className="data">
                <thead><tr><th>Fleet</th><th>Policy</th><th>Reached</th><th>Burned</th><th>Tonnes in time</th></tr></thead>
                <tbody>{rows.map((r) => <tr key={r.policy + r.fleet_scale}><td>{r.fleet_scale}×</td><td>{r.policy}</td><td>{r.burned_fields_reached}</td><td>{r.burned_fields_total}</td><td>{r.tonnes_cleared_in_time.toFixed(0)}</td></tr>)}</tbody>
              </table>
            </details>
          </article>
          <article className="card">
            <h2>What this does and doesn't show</h2>
            <p style={{ fontSize: 14 }}>
              At equal information the two policies are within one or two fields of each other. Most 2025 burns happened within about two days
              of harvest, so whoever learns of the harvest first wins; better routing alone can't beat that.
            </p>
            <p style={{ fontSize: 14 }}>
              Forecast check:{" "}
              <Tip text="Share of pre-harvest forecasts whose P10–P90 range contained the actual harvest date. A well-calibrated 80% range should be near 0.8.">
                window coverage <b className="num">{rows[0].window_coverage !== null ? `${Math.round((by("strawlink", 1)?.window_coverage ?? 0) * 100)}%` : "—"}</b>
              </Tip>
              {" · "}
              <Tip text="Mean absolute percentage error of next-week village straw volume (P50).">
                village volume error <b className="num">{by("strawlink", 1)?.village_volume_mape?.toFixed(2) ?? "—"}</b>
              </Tip>
            </p>
            <ul style={{ fontSize: 13, paddingLeft: 18 }}>
              {data?.caveats.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </article>
        </div>
      )}
      <article className="card" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ marginRight: "auto" }}>Replay {at ? fmtDate(at) : ""}</h2>
          <div className="seg" role="group" aria-label="Policy" style={{ display: "flex", border: "1px solid var(--line)", borderRadius: 10, padding: 3 }}>
            <button aria-pressed={policy === "strawlink"} onClick={() => setPolicy("strawlink")}>StrawLink</button>
            <button aria-pressed={policy === "baseline"} onClick={() => setPolicy("baseline")}>Baseline</button>
          </div>
          <select className="btn" value={scale} onChange={(e) => setScale(+e.target.value)} aria-label="Fleet size">
            {scales.map((s) => <option key={s} value={s}>{s}× fleet</option>)}
          </select>
          <button className="btn primary" onClick={() => { if (replay.data && day >= replay.data.dates.length - 1) setDay(0); setPlaying((p) => !p); }}>
            {playing ? "Pause" : "Play season"}
          </button>
        </div>
        {replay.data && (
          <input type="range" min={0} max={replay.data.dates.length - 1} value={day} onChange={(e) => setDay(+e.target.value)} style={{ width: "100%", marginTop: 10 }} aria-label="Replay day" />
        )}
        <div style={{ fontSize: 13 }} className="num">cleared {tally.cleared} · burned {tally.burned}</div>
        <div className="mapwrap" style={{ height: 420, marginTop: 8, borderRadius: 10, overflow: "hidden" }}>
          <FieldMap fc={fc} />
          <div className="legend">
            <div><i style={{ background: "var(--forecast)" }} />not harvested</div>
            <div><i style={{ background: "var(--ready)" }} />harvested, waiting</div>
            <div><i style={{ background: "var(--cleared)" }} />cleared</div>
            <div><i style={{ background: "var(--risk)" }} />burned (2025 imagery)</div>
          </div>
        </div>
        {replay.error && <div className="muted">Replay not published yet.</div>}
      </article>
    </div>
  );
}
