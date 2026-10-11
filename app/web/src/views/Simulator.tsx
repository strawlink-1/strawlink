import { useMemo } from "react";
import { daysBetween, fmtDate, machineName } from "../api";
import { describe } from "../scene/Vehicles";
import { useStageMode } from "../sim/stage";
import { useWorld } from "../sim/world";
import { Count, Group, InAbove, InBelow, InPanel, Legend, Slider, Tip } from "../ui/kit";
import { TimeBar, useNow } from "../ui/Transport";
import { addDays, beforePlan, legend } from "./common";

/**
 * The simulator: set the day, the fleet and the weather; the planner re-plans; run the day and watch.
 * Nothing on this page is scripted — every number and every movement comes from the plan the
 * planner returned for the sliders as they are now.
 */
export function Simulator() {
  const { geo } = useWorld();
  useStageMode(() => ({
    look: beforePlan,
    live: true,
    plantLabels: true,
    camera: { key: "sim", polar: 0.78, azim: -0.2, dist: (geo?.span ?? 100) * 1.18 },
  }), [geo]);

  return (
    <>
      <InPanel>
        <Controls />
        <Machines />
        <Colours />
      </InPanel>
      <InAbove><Scoreboard /></InAbove>
      <InBelow><TimeBar /></InBelow>
    </>
  );
}

/* ---------------------------------------------------------------- 1 · the inputs */

function Controls() {
  const { cells, inputs, setInputs, resetInputs, defaults, planning, simError, sim, meta, villages } = useWorld();
  const deadline = String(meta?.params.sowing_deadline_default ?? "");
  // the day slider runs from the first forecast harvest to the day before the sowing deadline
  const first = useMemo(() => cells.reduce((m, c) => (c.props.harvest_window && c.props.harvest_window.p50 < m ? c.props.harvest_window.p50 : m), "9999"), [cells]);
  const start = first === "9999" ? inputs.date : addDays(first, -1);
  const span = Math.max(1, daysBetween(start, deadline) - 1);
  const dayIdx = Math.min(span, Math.max(0, daysBetween(start, inputs.date)));
  const cut = cells.filter((c) => inputs.confirmed.includes(c.id) || (c.props.harvest_window && c.props.harvest_window.p50 <= inputs.date)).length;
  const wetAbove = sim?.inputs.rain_wet_threshold_mm ?? Number(meta?.params.rain_wet_threshold_mm ?? 5);
  const changed = defaults && JSON.stringify(defaults) !== JSON.stringify(inputs);
  // rain the weather service reports for each village; the planner reads it before every plan
  const seen = sim?.inputs.rain_by_village ?? null;
  const replayDays = meta?.weather_replay_days ?? [];
  const longDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  // what each kind of machine does in the plan the planner returned: stops per machine type
  const use = useMemo(() => {
    const n = { baler_set: 0, seeder: 0, truck: 0 };
    for (const a of sim?.plan.assignments ?? []) n[a.type] += a.stops.length;
    return n;
  }, [sim]);
  const trips = (sim?.inputs.fleet.truck ?? 0) * Number(meta?.params.truck_trips_per_day ?? 0);
  const fields = (n: number) => `${n} field${n === 1 ? "" : "s"}`;

  return (
    <Group title="Set up the day" aside={changed ? <button type="button" className="link" onClick={resetInputs}>Reset</button> : "move a slider"}>
      <Slider label="Day" value={dayIdx} min={0} max={span} onChange={(v) => setInputs({ date: addDays(start, v) })}
              show={fmtDate(inputs.date)}
              hint={<><b>{cut}</b> of {cells.length} fields are harvested by this day · {Math.max(0, daysBetween(inputs.date, deadline))} days to the sowing deadline</>} />
      <Slider label="Baler sets" value={inputs.baler_set} min={0} max={8} onChange={(v) => setInputs({ baler_set: v })}
              hint={<>bale the straw for a plant{sim && <> · <b>{fields(use.baler_set)}</b> baled in this plan</>}</>} />
      <Slider label="Super Seeders" value={inputs.seeder} min={0} max={8} onChange={(v) => setInputs({ seeder: v })}
              hint={<>sow wheat straight into the straw{sim && <> · <b>{fields(use.seeder)}</b> sown in this plan</>}</>} />
      <Slider label="Trucks" value={inputs.truck} min={0} max={8} onChange={(v) => setInputs({ truck: v })}
              hint={<>carry the bales to the plants{sim && trips > 0 && <> · <b>{use.truck} of {trips}</b> trips used</>}</>} />
      {sim && !planning && inputs.baler_set > 0 && inputs.truck === 0 && (
        <p className="note limit">Baled straw needs a truck to carry it away. With no trucks, nothing is baled.</p>
      )}
      {sim && !planning && inputs.baler_set > 0 && trips > 0 && use.truck >= trips && (
        <p className="note limit"><Tip text={`Each truck makes ${String(meta?.params.truck_trips_per_day)} trips a day (an assumption in config/params.yaml) and every baled field needs at least one.`}>Every truck trip is used</Tip>, so more baler sets need more trucks.</p>
      )}
      <div className="weather" aria-label="Rain from the weather service">
        <div className="weather-top">
          <b>Rain, last 3 days</b>
          <select value={inputs.weather_date} onChange={(e) => setInputs({ weather_date: e.target.value })} aria-label="Which weather the plan uses">
            <option value="">forecast for this day</option>
            {replayDays.map((d) => <option key={d} value={d}>real rain of {longDate(d)}</option>)}
          </select>
        </div>
        {seen && sim?.inputs.weather_source === "open-meteo" ? (
          <ul>
            {villages.map((v) => {
              const mm = seen[v.id] ?? 0;
              return <li key={v.id} className={mm >= wetAbove ? "wet" : ""}><span>{v.name}</span><b>{mm.toFixed(1)} mm</b><i>{mm >= wetAbove ? "too wet" : "workable"}</i></li>;
            })}
          </ul>
        ) : <p className="note">{sim ? "The weather service did not answer; the plan assumes no rain." : "Reading the weather…"}</p>}
        <small>Read from Open-Meteo for each village before every plan. Nobody enters it.</small>
      </div>
      <Slider label="Extra rain" value={inputs.rain_mm} min={0} max={30} onChange={(v) => setInputs({ rain_mm: v })}
              show={`${inputs.rain_mm} mm`} mark={{ at: wetAbove, label: `too wet above ${wetAbove} mm` }}
              hint={
                <>
                  over{" "}
                  <select value={inputs.rain_village} onChange={(e) => setInputs({ rain_village: e.target.value })} aria-label="Where it rains">
                    <option value="all">the whole block</option>
                    {villages.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                  {" "}· a what-if on top of the weather above
                </>
              } />
      {inputs.confirmed.length > 0 && (
        <p className="note">{inputs.confirmed.length} farmer message{inputs.confirmed.length === 1 ? "" : "s"} added: {inputs.confirmed.join(", ")}.</p>
      )}
      <p className={`status ${planning ? "busy" : simError ? "bad" : ""}`} role="status">
        {planning ? <><span className="spin" />The planner is working out a new plan…</>
          : simError ? <>The planner could not plan this: {simError}</>
          : sim && sim.plan.totals.fields_planned === 0 ? <>Plan ready: no field can be cleared with this setup.</>
          : sim?.inputs.saved ? <>This is today's saved plan. Press “Run the day”, or move a slider to ask the planner “what if?”.</>
          : sim ? <>What-if plan ready — solved in {sim.plan.solver.runtime_s.toFixed(1)} s. Press “Run the day”.</>
          : "Waiting for the first plan…"}
      </p>
    </Group>
  );
}

/* ---------------------------------------------------------------- 2 · what each machine is doing right now */

function Machines() {
  const { day, fleet, follow, setFollow, cellById } = useWorld();
  const now = useNow();
  if (!day) return null;
  const village = (id: string) => cellById.get(id)?.props.village_name;
  const resting = fleet.filter((m) => !m.works);
  return (
    <Group title="Machines" aside="click one to follow it">
      {fleet.length === 0 && <p className="note">There are no machines. Move a slider.</p>}
      <ul className="machines">
        {day.tracks.map((t) => (
          <li key={t.id}>
            <button type="button" aria-pressed={follow === t.id} onClick={() => setFollow(follow === t.id ? null : t.id)}>
              <i className={`dot ${t.type}`} />
              <b>{machineName(t.id)}</b>
              <span>{describe(t, now, village)}</span>
            </button>
          </li>
        ))}
        {resting.map((m) => (
          <li key={m.id} className="rest">
            <i className={`dot ${m.type}`} />
            <b>{machineName(m.id)}</b>
            <span>no work in this plan</span>
          </li>
        ))}
      </ul>
    </Group>
  );
}

/** The colour key, counted for the time on the clock: a field moves from "machine comes today" to "cleared" as the day runs. */
function Colours() {
  const { cells, day } = useWorld();
  const now = useNow();
  const base = useMemo(() => legend(cells, beforePlan, ["paddy", "straw", "sched", "soil", "wet", "risk"]), [cells]);
  const visits = day ? [...day.service.values()] : [];
  const done = visits.filter((v) => v.t1 <= now).length;
  const coming = visits.length - done;
  const items = base.map((i) =>
    i.look === "sched" ? { ...i, n: coming }
      : i.look === "soil" ? { ...i, n: (i.n ?? 0) + done }
      : i.look === "straw" ? { ...i, n: Math.max(0, (i.n ?? 0) - visits.length) }
      : i);
  return <Group title="Field colours"><Legend items={items} /></Group>;
}

/* ---------------------------------------------------------------- 3 · the result, updating as the day runs */

function Scoreboard() {
  const { plan, day, cells, inputs, meta, planning } = useWorld();
  const now = useNow();
  if (!plan || !day) return <div className="score"><div className="score-wait">{planning ? "Planning the day…" : "Loading…"}</div></div>;

  const visits = [...day.service.values()];
  const done = visits.filter((v) => v.t1 <= now);
  const tonnes = done.reduce((s, v) => s + v.tonnes, 0);
  const waiting = cells.filter((c) => c.props.status === "ready").length;
  const wet = cells.filter((c) => c.props.status === "wet").length;
  const harvested = waiting + wet + cells.filter((c) => c.props.status === "scheduled").length;
  const planned = plan.totals.fields_planned;
  const deadline = String(meta?.params.sowing_deadline_default ?? "");
  const left = Math.max(0, daysBetween(inputs.date, deadline));
  const need = planned > 0 ? Math.ceil(harvested / planned) : Infinity;
  const ok = need <= left;

  return (
    <div className={`score ${planning ? "stale" : ""}`}>
      <div className="tile">
        <b><Count value={done.length} /><small> / {planned}</small></b>
        <span><Tip text="Fields whose machine has finished by the time on the clock, out of the fields the plan clears today (plan.totals.fields_planned).">fields cleared today</Tip></span>
        <i className="bar"><i style={{ width: `${planned ? (done.length / planned) * 100 : 0}%` }} /></i>
      </div>
      <div className="tile">
        <b><Count value={tonnes} /><small> / {plan.totals.tonnes_planned.toFixed(0)} t</small></b>
        <span><Tip text="Straw on the fields cleared so far, out of the day's total (plan.totals.tonnes_planned). Tonnes = field area × straw per hectare, an assumption.">straw dealt with</Tip></span>
        <i className="bar gold"><i style={{ width: `${plan.totals.tonnes_planned ? (tonnes / plan.totals.tonnes_planned) * 100 : 0}%` }} /></i>
      </div>
      <div className="tile">
        <b className={waiting ? "warn" : ""}><Count value={waiting} /></b>
        <span><Tip text="Harvested fields with straw on them that no machine reaches today.">fields still waiting</Tip>{wet > 0 && <> · <em className="wet">{wet} too wet</em></>}</span>
      </div>
      <div className={`verdict ${harvested === 0 ? "" : ok ? "ok" : "bad"}`}>
        {harvested === 0 ? (
          <><b>Nothing to clear yet</b><span>No field is harvested by {fmtDate(inputs.date)}.</span></>
        ) : planned === 0 ? (
          wet > 0
            ? <><b>Too wet to work</b><span>{wet} harvested fields are too wet for machines today.</span></>
            : <><b>Nothing gets cleared</b><span>No machine can work with this setup.</span></>
        ) : (
          <>
            <b>{ok ? "Enough machines" : "Not enough machines"}</b>
            <span>
              <Tip text={`${harvested} harvested fields ÷ ${planned} cleared today, rounded up. A rough guide: it assumes every day goes like this one and ignores fields not yet harvested.`}>
                about {need} day{need === 1 ? "" : "s"} needed
              </Tip>{" · "}{left} day{left === 1 ? "" : "s"} left before sowing
            </span>
          </>
        )}
      </div>
    </div>
  );
}
