import { useState } from "react";
import { API, daysBetween, fmtDate, fmtTime, post, STATUS, type Slot, type Status, type Window } from "../api";
import { useApp, useFetch } from "../state";
import { Tip } from "./Tip";

type Why = {
  field_id: string; village_name: string; area_ha: number; straw_t: number; sowing_deadline: string; status: Status;
  harvest_window: Window | null; satellite_forecast: Window | null; route?: string; route_reason?: string;
  priority?: number; priority_parts?: { tonnes: number; urgency: number; bonus: number; dry: number };
  days_left?: number; dry?: boolean; rain_mm_3d?: number; rain_wet_threshold_mm: number; slot?: (Slot & { operator?: string }) | null;
  unassigned_reason?: string | null; cleared_on?: string | null; certificate_id?: string | null; boundary?: string;
  events: { ts: string; type: string; date?: string; source?: string }[];
};

const REASON: Record<string, string> = {
  wet: "Waiting for the field to dry after rain.",
  deadline: "No machine can reach it before the sowing deadline.",
  capacity: "Machines or trucks are fully booked in the next days.",
  no_machine: "No available machine of the needed type.",
};

export function WhyCard({ id, onClose }: { id: string; onClose?: () => void }) {
  const { date, version, bump } = useApp();
  const { data: w, error } = useFetch<Why>(`/fields/${id}?date=${date}`, [version, date]);
  const [busy, setBusy] = useState(false);
  if (error) return <section className="why">Could not load {id}: {error}</section>;
  if (!w) return <section className="why muted">Loading {id}…</section>;
  const st = STATUS[w.status];
  const hw = w.harvest_window;
  const demo = new URLSearchParams(location.search).has("demo");

  return (
    <div className="why">
      <section>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
          <div>
            <h2>{w.field_id}</h2>
            <div className="sub">
              {w.village_name} · <Tip text="Area of the parcel; straw = area × straw_t_per_ha (config assumption).">{w.area_ha.toFixed(2)} ha · {w.straw_t.toFixed(1)} t straw</Tip>
            </div>
          </div>
          {onClose && <button className="btn" onClick={onClose} aria-label="Close field details">Close</button>}
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="status-pill"><i style={{ background: w.status === "scheduled" && w.route === "bale" ? "var(--bale)" : st.color }} />{st.label}</span>
          {w.boundary === "grid_cell_approx" && <span className="synthetic-tag">approx. boundary</span>}
        </div>
      </section>

      <section>
        <h3>Harvest window</h3>
        {hw ? (
          <>
            <WindowBar hw={hw} today={date} deadline={w.sowing_deadline} />
            <div style={{ fontSize: 13 }}>
              {hw.source === "confirmed" ? (
                <>Confirmed harvest <b>{fmtDate(hw.p50)}</b> ({hw.confirmed_by ?? "farmer"}) — overrides the satellite forecast.</>
              ) : (
                <>
                  Most likely <b>{fmtDate(hw.p50)}</b>; 80% range{" "}
                  <Tip text="P10–P90 from the LightGBM quantile model on Sentinel-2 NDVI history. In 2025 validation only ~35–43% of harvests fell inside this range, so treat it as narrow.">
                    {fmtDate(hw.p10)}–{fmtDate(hw.p90)}
                  </Tip>
                  . Satellite forecast issued {fmtDate(hw.issued_on)}.
                </>
              )}
            </div>
          </>
        ) : (
          <div className="muted">No forecast yet.</div>
        )}
      </section>

      <section>
        <h3>Route</h3>
        {w.route ? (
          <>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              {w.route === "bale" ? "Bale and haul to a plant" : w.route === "seed" ? "Super Seeder in place" : "At risk"}
            </div>
            <div className="reason">{w.route_reason}</div>
          </>
        ) : (
          <div className="muted">Not planned yet — run a re-plan.</div>
        )}
      </section>

      {w.priority_parts && (
        <section>
          <h3>
            <Tip text="priority = tonnes × urgency × (1 + loyalty bonus) × dry. Burn history never raises priority; only a recorded no-burn season earns the bonus.">
              Queue priority {w.priority?.toFixed(3)}
            </Tip>
          </h3>
          <div className="parts">
            <div><div className="v">{w.priority_parts.tonnes.toFixed(1)}</div><div className="l">tonnes</div></div>
            <div>
              <Tip text={`exp(−days_left / urgency_tau_days); ${w.days_left} days between ready day and sowing deadline.`}>
                <div className="v">{w.priority_parts.urgency.toFixed(3)}</div>
              </Tip>
              <div className="l">urgency</div>
            </div>
            <div>
              <Tip text="+0.2 (config) if last season shows no burn. Unknown or burned → 0. Never negative, never a penalty.">
                <div className="v">+{w.priority_parts.bonus.toFixed(1)}</div>
              </Tip>
              <div className="l">no-burn bonus</div>
            </div>
            <div><div className="v">{w.priority_parts.dry ? "yes" : "no"}</div><div className="l">dry</div></div>
          </div>
        </section>
      )}

      <section>
        <h3>Wetness</h3>
        <Tip text="Rain over the last 3 days at the block centre (Open-Meteo) plus any rain injected in the demo console.">
          <span className="num">{w.rain_mm_3d ?? 0} mm</span>
        </Tip>{" "}
        in 3 days · wet above <span className="num">{w.rain_wet_threshold_mm} mm</span>
      </section>

      <section>
        <h3>Machine</h3>
        {w.slot ? (
          <div>
            <b>{w.slot.machine_id}</b> ({w.slot.operator}) · {fmtDate(w.slot.date)}, <span className="num">{fmtTime(w.slot.arrive)}–{fmtTime(w.slot.depart)}</span>
          </div>
        ) : w.cleared_on ? (
          <div>Cleared on {fmtDate(w.cleared_on)}.</div>
        ) : (
          <div className="muted">{w.unassigned_reason ? REASON[w.unassigned_reason] : "Not in today's plan."}</div>
        )}
        {w.certificate_id && (
          <div style={{ marginTop: 8 }}>
            <a href={`/verify/${w.certificate_id}`}>Certificate {w.certificate_id}</a>
          </div>
        )}
        {demo && !w.cleared_on && (
          <button
            className="btn"
            style={{ marginTop: 10 }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await post(`/fields/${w.field_id}/cleared`, { date });
              setBusy(false);
              bump();
            }}
          >
            Mark cleared
          </button>
        )}
      </section>

      {w.events.length > 0 && (
        <section>
          <h3>Recent events</h3>
          <ul className="list" style={{ fontSize: 13 }}>
            {w.events.map((e) => (
              <li key={e.ts}>
                <span className="num muted">{e.ts.slice(5, 16).replace("T", " ")}</span> {e.type.replace("_", " ")}
                {e.date ? ` · ${fmtDate(e.date)}` : ""} {e.source ? `· ${e.source}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="muted" style={{ fontSize: 12 }}>
        Data: <a href={`${API}/fields/${w.field_id}?date=${date}`}>raw JSON</a> · fleet and parcel boundary are synthetic.
      </section>
    </div>
  );
}

function WindowBar({ hw, today, deadline }: { hw: Window; today: string; deadline: string }) {
  const start = [hw.p10, today].sort()[0];
  const lo = daysBetween(start, start) - 2;
  const hi = Math.max(daysBetween(start, deadline), daysBetween(start, hw.p90)) + 2;
  const sx = (d: string) => ((daysBetween(start, d) - lo) / (hi - lo)) * 100;
  return (
    <div className="window-bar">
      <svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden>
        <line x1="0" x2="100" y1="17" y2="17" stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <rect x={sx(hw.p10)} y="10" width={Math.max(0.8, sx(hw.p90) - sx(hw.p10))} height="14" rx="1" fill="var(--bale)" opacity="0.35" />
        <rect x={sx(hw.p50) - 0.5} y="6" width="1" height="22" fill="var(--bale)" />
        <line x1={sx(today)} x2={sx(today)} y1="2" y2="32" stroke="var(--ink)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <line x1={sx(deadline)} x2={sx(deadline)} y1="2" y2="32" stroke="var(--risk)" strokeWidth="2" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }} className="muted num">
        <span>plan day {fmtDate(today)}</span>
        <span style={{ color: "var(--risk)" }}>deadline {fmtDate(deadline)}</span>
      </div>
    </div>
  );
}
