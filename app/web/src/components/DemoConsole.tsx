import { useState } from "react";
import { post } from "../api";
import { useApp } from "../state";

type Replan = { strawlink?: { totals: { fields_planned: number; tonnes_planned: number; fields_at_risk: number }; solver: { runtime_s: number } }; messages?: number };

export function DemoConsole() {
  const { meta, date, setDate, bump } = useApp();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [village, setVillage] = useState("all");
  const [mm, setMm] = useState(20);
  const [fid, setFid] = useState("F0001");
  const [hdate, setHdate] = useState(date);
  const [min, setMin] = useState(false);

  const run = async (label: string, fn: () => Promise<{ replan?: Replan } & Replan>) => {
    setBusy(true);
    const t = performance.now();
    try {
      const r = await fn();
      const rp = (r.replan ?? r) as Replan;
      const tot = rp.strawlink?.totals;
      setLog((l) => [`${label} ✓ ${((performance.now() - t) / 1000).toFixed(1)}s${tot ? ` → ${tot.fields_planned} fields, ${tot.tonnes_planned.toFixed(0)} t today, ${tot.fields_at_risk} at risk` : ""}${rp.messages ? `, ${rp.messages} msgs` : ""}`, ...l].slice(0, 12));
      bump();
    } catch (e) {
      setLog((l) => [`${label} ✗ ${String(e)}`, ...l]);
    } finally {
      setBusy(false);
    }
  };

  if (min) return <button className="btn primary" style={{ position: "fixed", right: 16, bottom: 16, zIndex: 30 }} onClick={() => setMin(false)}>Demo console</button>;

  return (
    <aside className="demo" aria-label="Demo console">
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h4>Demo console</h4>
        <button className="btn" style={{ padding: "0 8px" }} onClick={() => setMin(true)} aria-label="Minimise demo console">–</button>
      </div>
      <div className="row">
        <label htmlFor="pd" style={{ width: 70 }}>Plan day</label>
        <input id="pd" type="date" value={date} onChange={(e) => { setDate(e.target.value); setHdate(e.target.value); }} />
        <button className="btn" disabled={busy} onClick={() => run("Re-plan", () => post("/replan", { date }))}>Re-plan</button>
      </div>
      <div className="row">
        <select aria-label="Village" value={village} onChange={(e) => setVillage(e.target.value)}>
          <option value="all">All villages</option>
          {meta?.villages.map((v) => <option key={v.properties.village_id} value={v.properties.village_id}>{v.properties.name}</option>)}
        </select>
        <input aria-label="Rain mm" type="number" value={mm} min={1} style={{ width: 56, flex: "none" }} onChange={(e) => setMm(+e.target.value)} />
        <button className="btn" disabled={busy} onClick={() => run(`Rain ${mm} mm`, () => post("/events/rain", { village_id: village, mm, date }))}>Inject rain</button>
      </div>
      <div className="row">
        <input aria-label="Field ID" value={fid} onChange={(e) => setFid(e.target.value.toUpperCase())} style={{ width: 70, flex: "none" }} />
        <input aria-label="Harvest date" type="date" value={hdate} onChange={(e) => setHdate(e.target.value)} />
      </div>
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => run(`Confirm ${fid}`, () => post("/events/confirm", { field_id: fid, date: hdate, source: "whatsapp", plan_date: date }))}>Confirm harvest</button>
        <button className="btn" disabled={busy} onClick={() => run(`Missed call ${fid}`, () => post("/simulate/missed-call", { field_id: fid, plan_date: date }))}>Missed call</button>
        <button className="btn" disabled={busy} onClick={() => run(`Cleared ${fid}`, () => post(`/fields/${fid}/cleared`, { date }))}>Cleared</button>
      </div>
      <div className="log" aria-live="polite">{busy ? "working…\n" : ""}{log.join("\n")}</div>
    </aside>
  );
}
