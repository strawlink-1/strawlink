import { fmtDate, fmtTime, machineName } from "../api";
import { LOOKS } from "../scene/looks";
import { useWorld } from "../sim/world";
import { byStatus } from "../views/common";
import { Icon, Tip } from "./kit";

const WAITING: Record<string, string> = {
  wet: "Too wet to work today — the machines wait for it to dry.",
  deadline: "No machine can reach it before the sowing deadline.",
  capacity: "Harvested, but every machine is busy today.",
  no_machine: "No machine of the right kind is available.",
};

/**
 * One field under the current inputs: when it is harvested, what happens today and why.
 * Everything here comes from the planner's answer to the sliders, so it changes with them.
 */
export function FieldCard({ id }: { id: string }) {
  const { cellById, plan, inputs, setInputs, select, sim } = useWorld();
  const cell = cellById.get(id);
  if (!cell) return null;
  const p = cell.props;
  const look = LOOKS[byStatus(cell)];
  const hw = p.harvest_window;
  const entry = plan?.fields?.find((f) => f.field_id === id);
  const ranked = [...(plan?.fields ?? [])].sort((a, b) => b.priority - a.priority);
  const rank = ranked.findIndex((f) => f.field_id === id) + 1;
  const visit = plan?.assignments.filter((a) => a.type !== "truck").flatMap((a) => a.stops.map((s) => ({ ...s, machine: a.machine_id }))).find((s) => s.field_id === id);
  const why = plan?.unassigned.find((u) => u.field_id === id)?.reason;
  const confirmed = inputs.confirmed.includes(id);

  return (
    <aside id="fieldcard" aria-label={`Field ${id}`}>
      <header>
        <div><b>Field {id}</b><span>{p.village_name} · {p.straw_t.toFixed(1)} t of straw on {p.area_ha.toFixed(2)} ha</span></div>
        <button type="button" className="x" onClick={() => select(null)} aria-label="Close"><Icon name="x" size={16} /></button>
      </header>
      <p className="pill"><i style={{ background: look.color, borderColor: look.halo ?? "transparent" }} />{look.label}</p>
      <dl>
        <dt>Harvest</dt>
        <dd>
          {confirmed ? <>Farmer says it was <b>harvested today</b>.</>
            : hw ? <>{hw.source === "confirmed" ? "Confirmed for" : "Satellite forecast:"} <b>{fmtDate(hw.p50)}</b>{hw.source !== "confirmed" && <> ({fmtDate(hw.p10)}–{fmtDate(hw.p90)})</>}</>
            : "No forecast yet."}
        </dd>
        <dt>Today</dt>
        <dd>
          {visit ? <><b>{machineName(visit.machine)}</b> arrives {fmtTime(visit.arrive)}, finished {fmtTime(visit.depart)}.</>
            : p.status === "cleared" ? "Already cleared."
            : p.status === "forecast" ? "Crop still standing; nothing to clear yet."
            : WAITING[why ?? (p.status === "wet" ? "wet" : "capacity")]}
        </dd>
        {entry && (
          <>
            <dt>Method</dt>
            <dd>{entry.route === "bale" ? "Bale the straw and truck it to a plant." : entry.route === "seed" ? "Sow wheat straight into the straw." : "At risk: no method reaches it in time."}</dd>
            <dt><Tip text="Fair queue: tonnes × urgency × (1 + no-burn bonus), dry fields only. Urgency rises as the sowing deadline nears. Burn history never raises a field's place.">Queue</Tip></dt>
            <dd>
              {rank > 0 && <><b>#{rank}</b> of {ranked.length} · </>}
              {entry.priority_parts.tonnes.toFixed(1)} t × urgency {entry.priority_parts.urgency.toFixed(3)}{entry.priority_parts.bonus > 0 && <> × no-burn bonus</>} · {entry.days_left} days to deadline
            </dd>
          </>
        )}
      </dl>
      {(p.status === "forecast" || confirmed) && (
        <button type="button" className="btn sm" disabled={!sim}
                onClick={() => setInputs({ confirmed: confirmed ? inputs.confirmed.filter((f) => f !== id) : [...inputs.confirmed, id] })}>
          <Icon name="phone" size={14} /> {confirmed ? "Undo the farmer's message" : "Farmer says: harvested today"}
        </button>
      )}
    </aside>
  );
}
