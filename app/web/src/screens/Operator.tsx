import { useCallback, useMemo, useState } from "react";
import { fmtTime, STATUS, type FC, type Status } from "../api";
import { FieldMap } from "../components/FieldMap";
import { SeasonClock } from "../components/SeasonClock";
import { Tip } from "../components/Tip";
import { WhyCard } from "../components/WhyCard";
import { useApp, useFetch } from "../state";

type Plan = {
  plan_id: string; policy: string;
  assignments: { machine_id: string; type: string; stops: { field_id: string; arrive: string; depart: string; tonnes: number; method: string }[]; deliveries: { plant_id: string; tonnes: number }[] }[];
  unassigned: { field_id: string; reason: string }[];
  totals: { tonnes_planned: number; fields_planned: number; fields_at_risk: number };
  solver: { status: string; runtime_s: number };
};
type Exposure = { label: string; wind: { wind_from_deg: number; wind_speed_kmh: number; hours: string }; exposed: { kind: string; name: string; location: [number, number]; nearest_km: number; from_fields: string[] }[]; risk_fields: string[] };

export function Operator() {
  const { meta, date, version } = useApp();
  const [policy, setPolicy] = useState<"strawlink" | "baseline">("strawlink");
  const [officer, setOfficer] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const q = `date=${date}`;
  const fields = useFetch<FC>(date ? `/fields?${q}` : null, [version]);
  const plan = useFetch<Plan>(date ? `/plan?${q}&policy=${policy}` : null, [version, policy]);
  const routes = useFetch<GeoJSON.FeatureCollection>(date && plan.data ? `/routes?${q}&policy=${policy}` : null, [plan.data?.plan_id]);
  const exposure = useFetch<Exposure>(officer && date ? `/exposure?${q}` : null, [version]);

  // baseline view: recolour scheduled fields from the baseline plan
  const fc = useMemo<FC | null>(() => {
    if (!fields.data) return null;
    if (policy === "strawlink" || !plan.data) return fields.data;
    const sched = new Map<string, string>();
    for (const a of plan.data.assignments) if (a.type !== "truck") for (const s of a.stops) sched.set(s.field_id, s.method);
    return {
      ...fields.data,
      features: fields.data.features.map((f) => {
        const p = f.properties;
        let status: Status = p.status;
        if (status === "scheduled") status = "ready";
        if (sched.has(p.field_id) && status !== "cleared") status = "scheduled";
        return { ...f, properties: { ...p, status, route: (sched.get(p.field_id) as "bale") ?? p.route } };
      }),
    };
  }, [fields.data, plan.data, policy]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of fc?.features ?? []) c[f.properties.status] = (c[f.properties.status] ?? 0) + 1;
    return c;
  }, [fc]);
  const riskSet = useMemo(() => new Set(exposure.data?.risk_fields ?? []), [exposure.data]);
  const dim = useCallback((p: FC["features"][number]["properties"]) => officer && !riskSet.has(p.field_id) && p.status !== "at_risk", [officer, riskSet]);

  const t = plan.data?.totals;
  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
      <SeasonClock />
      <div className="operator">
        <aside className="panel left" aria-label="Today's plan">
          <section>
            <h3>Plan for {date}</h3>
            {plan.error && <div className="muted">No {policy} plan for this day yet. Use the demo console (add <code>?demo=1</code>) or wait for the 06:00 run.</div>}
            {t && (
              <div className="kpis">
                <div className="kpi"><div className="v num">{t.fields_planned}</div><div className="l"><Tip text="Fields with a machine stop today in this plan (plan.totals.fields_planned).">fields today</Tip></div></div>
                <div className="kpi"><div className="v num">{t.tonnes_planned.toFixed(0)} t</div><div className="l"><Tip text="Straw tonnes on today's stops (plan.totals.tonnes_planned). Tonnes are estimated as area × 6 t/ha (assumption).">straw today</Tip></div></div>
                <div className="kpi"><div className="v num" style={{ color: "var(--risk)" }}>{t.fields_at_risk}</div><div className="l"><Tip text="Fields neither route can reach before the sowing deadline.">at risk</Tip></div></div>
                <div className="kpi"><div className="v num" style={{ color: "var(--wet)" }}>{counts.wet ?? 0}</div><div className="l"><Tip text="Ready fields where 3-day rain exceeds the wet threshold; machines wait.">too wet</Tip></div></div>
              </div>
            )}
            {plan.data && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>solver {plan.data.solver.status} · {plan.data.solver.runtime_s.toFixed(1)} s · {plan.data.plan_id}</div>}
          </section>
          <section>
            <h3>Machines today</h3>
            <ul className="list">
              {(plan.data?.assignments ?? []).filter((a) => a.type !== "truck").map((a) => (
                <li key={a.machine_id}>
                  <div style={{ padding: "4px 8px" }}>
                    <b>{a.machine_id}</b> <span className="muted">{a.type === "seeder" ? "Super Seeder" : "baler set"}</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                      {a.stops.map((s) => (
                        <button key={s.field_id} className="chip" onClick={() => setSel(s.field_id)} title={`${fmtTime(s.arrive)}–${fmtTime(s.depart)}`}>
                          {s.field_id} <span className="muted">{fmtTime(s.arrive)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>Waiting</h3>
            <ul className="list" style={{ fontSize: 13 }}>
              {Object.entries(
                (plan.data?.unassigned ?? []).reduce<Record<string, number>>((m, u) => ((m[u.reason] = (m[u.reason] ?? 0) + 1), m), {}),
              ).map(([r, n]) => (
                <li key={r}><span className="num">{n}</span> {r === "wet" ? "too wet" : r === "capacity" ? "no machine free in time" : r === "deadline" ? "past deadline" : "no machine of type"}</li>
              ))}
            </ul>
          </section>
        </aside>

        <div className="mapwrap">
          <FieldMap
            fc={fc}
            selected={sel}
            onSelect={setSel}
            dim={dim}
            overlay={{ routes: routes.data, exposure: officer ? exposure.data?.exposed : null, plants: meta?.plants }}
          />
          <div className="map-overlay">
            <div className="seg" role="group" aria-label="Policy">
              <button aria-pressed={policy === "strawlink"} onClick={() => setPolicy("strawlink")}>StrawLink plan</button>
              <button aria-pressed={policy === "baseline"} onClick={() => setPolicy("baseline")}>First-come baseline</button>
            </div>
            <div className="seg">
              <button aria-pressed={officer} onClick={() => setOfficer((o) => !o)}>Officer view: at-risk + exposure</button>
            </div>
          </div>
          <div className="legend" aria-label="Legend">
            {(Object.keys(STATUS) as Status[]).map((s) => (
              <div key={s}>
                <i style={{ background: s === "scheduled" ? "linear-gradient(90deg, var(--bale) 50%, var(--seed) 50%)" : STATUS[s].color }} />
                <Tip text={STATUS[s].hint}>{STATUS[s].label}</Tip> <span className="num muted">{counts[s] ?? 0}</span>
              </div>
            ))}
            <div className="muted" style={{ fontSize: 11 }}>scheduled: gold = bale, teal = seed</div>
          </div>
        </div>

        <aside className="panel right" aria-label="Field details">
          {officer && exposure.data && (
            <section>
              <h3>{exposure.data.label}</h3>
              <div style={{ fontSize: 13 }}>
                Afternoon wind from <b className="num">{exposure.data.wind.wind_from_deg.toFixed(0)}°</b> at{" "}
                <span className="num">{exposure.data.wind.wind_speed_kmh} km/h</span> ({exposure.data.wind.hours}, Open-Meteo).{" "}
                {exposure.data.exposed.length} places downwind of {exposure.data.risk_fields.length} risk fields. Not a pollution reading.
              </div>
              <ul className="list" style={{ fontSize: 13, marginTop: 6 }}>
                {exposure.data.exposed.slice(0, 8).map((p) => (
                  <li key={p.name + p.kind}>{p.kind === "school" ? "School" : "Village"}: {p.name} · <span className="num">{p.nearest_km} km</span></li>
                ))}
              </ul>
            </section>
          )}
          {sel ? (
            <WhyCard id={sel} onClose={() => setSel(null)} />
          ) : (
            <section>
              <h3>Pick a field</h3>
              <p className="muted">Click a parcel on the map or a stop on the left to see why it got its route, priority and slot.</p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
