import { useCallback, useMemo, useState } from "react";
import { fmtDate } from "../api";
import type { Cell } from "../sim/geo";
import { useStageMode, type CameraSpec, type Look } from "../sim/stage";
import { useWorld } from "../sim/world";
import { useFetch } from "../state";
import { Count, Group, InPanel, Legend, Stat, Tip } from "../ui/kit";
import { legend } from "./common";

type Plant = {
  plant_id: string; name: string; weekly_capacity_t: number; depot_capacity_t: number; fill_t: number; fields_routed: number;
  weeks: { week_start: string; tonnes_p10: number; tonnes_p50: number; tonnes_p90: number }[];
  depot_projection: { date: string; fill_t: number }[]; projected_full_on: string | null; alert: boolean;
};

/** Where does the straw go? Which fields are baled for a plant, which are sown in place, and whether the plants have room. */
export function Plants() {
  const { cells, plants, plan, today, day, geo } = useWorld();
  const supply = useFetch<{ plants: Plant[]; method: string }>(today ? `/plants/supply?weeks=4&date=${today}` : null, []);
  const [open, setOpen] = useState<string | null>(null);
  const [shot, setShot] = useState<CameraSpec | null>(null);
  // the route the planner chose for each field under the simulator's current inputs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const routes = useMemo(() => new Map((plan?.fields ?? []).map((f) => [f.field_id, f.route])), [plan?.plan_id]);
  const look = useCallback((c: Cell): Look => {
    if (c.props.status === "cleared") return "soil";
    const route = routes.get(c.id) ?? c.props.route;
    return route === "bale" ? "bale" : route === "seed" ? "seed" : route === "at_risk" ? "risk" : "paddy";
  }, [routes]);
  useStageMode(() => ({
    look,
    trips: true,
    plantLabels: true,
    camera: shot ?? { key: "plants", polar: 0.82, azim: 0.3, dist: (geo?.span ?? 100) * 1.5 },
  }), [look, geo, shot]);

  const items = legend(cells, look, ["bale", "seed", "risk", "paddy"], { paddy: "Not planned yet" });
  const fly = (id: string) => {
    const p = plants.find((x) => x.id === id);
    setShot(p && open !== id ? { key: `plant-${id}`, target: p.at, dist: 46, polar: 1.0, azim: 0.3 } : null);
    setOpen(open === id ? null : id);
  };

  return (
    <InPanel>
      <h1>Where does the straw go?</h1>
      <p className="lede">Each field gets one of two methods. Baled straw is trucked to a plant that still has room this week. When the plants are full, a Super Seeder sows wheat straight into the straw.</p>
      <div className="stat-row">
        <Stat k="fields baled for a plant" v={<Count value={items[0].n ?? 0} />} tone="warn" />
        <Stat k="fields sown in place" v={<Count value={items[1].n ?? 0} />} />
      </div>
      <Group title="Field colours"><Legend items={items} /></Group>
      <p className="note">The arcs on the map are the {day?.trips.length ?? 0} truck trips in the simulator's current plan.</p>

      <Group title="Plants" aside="synthetic">
        {supply.error && <p className="note warn">Plant numbers are unavailable: {supply.error}</p>}
        {supply.data?.plants.map((p) => {
          const last = p.depot_projection[p.depot_projection.length - 1]?.fill_t ?? p.fill_t;
          const max = Math.max(p.weekly_capacity_t, ...p.weeks.map((w) => w.tonnes_p90), 1);
          const now = Math.min(100, (p.fill_t / p.depot_capacity_t) * 100), then = Math.min(100, (last / p.depot_capacity_t) * 100);
          return (
            <article key={p.plant_id} className={`plant ${open === p.plant_id ? "open" : ""}`}>
              <button type="button" className="plant-head" onClick={() => fly(p.plant_id)} aria-expanded={open === p.plant_id}>
                <b>{p.name.replace(" (synthetic)", "")}</b>
                <small>{p.fields_routed} fields · uses {p.weekly_capacity_t} t a week</small>
              </button>
              <div className="depot"><i style={{ width: `${now}%` }} /><i className={last >= p.depot_capacity_t ? "more full" : "more"} style={{ left: `${now}%`, width: `${Math.max(0, then - now)}%` }} /></div>
              <p className="plant-line">
                <Tip text="Straw stored now → projected in 7 days, against what the depot can hold. Projection: expected arrivals minus what the plant uses.">
                  <span className="num">{p.fill_t.toFixed(0)} → {last.toFixed(0)} of {p.depot_capacity_t} t</span>
                </Tip>
                {p.alert && <span className="alert">full by {fmtDate(p.projected_full_on)}</span>}
              </p>
              {open === p.plant_id && (
                <>
                  <svg className="bars" viewBox="0 0 300 92" role="img" aria-label={`Expected straw per week at ${p.name}`}>
                    <line x1="0" x2="300" y1={74 - (p.weekly_capacity_t / max) * 62} y2={74 - (p.weekly_capacity_t / max) * 62} className="cap" />
                    {p.weeks.map((w, i) => {
                      const bw = 300 / p.weeks.length, x = i * bw + 8, h = (v: number) => (v / max) * 62;
                      return (
                        <g key={w.week_start}>
                          <title>{`Week of ${fmtDate(w.week_start)}: ${w.tonnes_p50.toFixed(0)} t likely (range ${w.tonnes_p10.toFixed(0)}–${w.tonnes_p90.toFixed(0)} t)`}</title>
                          <rect x={x} y={74 - h(w.tonnes_p50)} width={bw - 16} height={Math.max(1, h(w.tonnes_p50))} rx="3" className="bar" />
                          <line x1={x + (bw - 16) / 2} x2={x + (bw - 16) / 2} y1={74 - h(w.tonnes_p90)} y2={74 - h(w.tonnes_p10)} className="whisker" />
                          <text x={x + (bw - 16) / 2} y="88" textAnchor="middle">{fmtDate(w.week_start)}</text>
                        </g>
                      );
                    })}
                  </svg>
                  <p className="note">Bars: straw expected each week. Dashed line: what the plant uses in a week.</p>
                </>
              )}
            </article>
          );
        })}
      </Group>
    </InPanel>
  );
}
